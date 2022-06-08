/** @noSelfInFile */
/**
 * Automatic Speed Control for the Long Island Rail Road.
 *
 * TODO: Implement brake assurance check. It's likely impossible to fail in the
 * sim, but it would still be a nice touch. It shows a yellow indicator in the
 * cockpit if successfully met.
 */

import * as cs from "./cabsignals";
import * as c from "./constants";
import * as frp from "./frp";
import { FrpEngine } from "./frp-engine";
import { foldWithResetBehavior, fsm } from "./frp-extra";
import * as rw from "./railworks";

export type AscState = { brakes: AscBrake };
export enum AscBrake {
    None,
    Penalty,
    Emergency,
}

type AscAccum = AscMode.Normal | [event: OverspeedEvent, acknowledged: boolean] | AscMode.Emergency;
type OverspeedEvent = { initSpeedMps: number };
enum AscMode {
    Normal,
    Emergency,
}

/**
 * Create a new ASC instance.
 * @param e The player's engine.
 * @param cabAspect A stream that indicates the current cab signal aspect.
 * @param acknowledge A behavior that indicates the state of the acknowledge
 * joystick.
 * @param coastOrBrake A behavior that indicates the master controller has been
 * placed into a braking or the coast position.
 * @param cutIn An event stream that indicates the state of the cut in control.
 * @param hasPower A behavior that indicates the unit is powered and keyed in.
 * @returns An event stream that commmunicates all state for this system.
 */
export function create(
    e: FrpEngine,
    cabAspect: frp.Behavior<cs.LirrAspect>,
    acknowledge: frp.Behavior<boolean>,
    coastOrBrake: frp.Behavior<boolean>,
    cutIn: frp.Stream<boolean>,
    hasPower: frp.Behavior<boolean>
): frp.Stream<AscState> {
    const isPlayerEngine = () => e.eng.GetIsEngineWithKey(),
        cutInOut$ = frp.compose(
            cutIn,
            fsm<boolean>(false),
            frp.filter(([from, to]) => from !== to && frp.snapshot(isPlayerEngine))
        );
    cutInOut$(([, to]) => {
        const msg = to ? "Enabled" : "Disabled";
        rw.ScenarioManager.ShowMessage("ASC Signal Speed Enforcement", msg, rw.MessageBox.Alert);
    });

    const isCutOut = frp.liftN(
            (cutIn, hasPower, isPlayerEngine) => !(cutIn && hasPower && isPlayerEngine),
            frp.stepper(cutIn, false),
            hasPower,
            isPlayerEngine
        ),
        aSpeedMps = () => Math.abs(e.rv.GetControlValue("SpeedometerMPH", 0) as number) * c.mph.toMps,
        isOverspeed = frp.liftN(
            (speedMps, cabAspect, cutOut) => !cutOut && speedMps > toOverspeedSetpointMps(cabAspect),
            aSpeedMps,
            cabAspect,
            isCutOut
        ),
        overspeed$ = frp.compose(
            e.createUpdateStream(),
            frp.map(_ => frp.snapshot(isOverspeed)),
            fsm(false),
            frp.filter(([from, to]) => !from && to),
            frp.map((_): OverspeedEvent => {
                return { initSpeedMps: frp.snapshot(aSpeedMps) };
            })
        );
    return frp.compose(
        e.createUpdateStream(),
        frp.merge<OverspeedEvent, number>(overspeed$),
        foldWithResetBehavior<AscAccum, number | OverspeedEvent>(
            (accum, value) => {
                if (accum === AscMode.Normal && typeof value === "number") {
                    // Do nothing.
                    return AscMode.Normal;
                } else if (accum == AscMode.Normal) {
                    // Enter the penalty state.
                    return [value as OverspeedEvent, false];
                } else if (accum === AscMode.Emergency) {
                    // Emergency braking; stay until the train has stopped.
                    const ack = frp.snapshot(acknowledge),
                        stopped = frp.snapshot(aSpeedMps) < c.stopSpeed;
                    return ack && stopped ? AscMode.Normal : AscMode.Emergency;
                } else if (!accum[1]) {
                    // Penalty braking, not acknowledged; we need to wait for
                    // acknowledgement from the engineer.
                    return [accum[0], frp.snapshot(acknowledge)];
                } else {
                    // Penalty braking, acknowledged; brake until the train is
                    // under-speed and the master controller is in a braking or
                    // coast position.
                    const underSpeed = frp.snapshot(aSpeedMps) < toUnderspeedSetpointMps(frp.snapshot(cabAspect));
                    return underSpeed && frp.snapshot(coastOrBrake) ? AscMode.Normal : accum;
                }
            },
            AscMode.Normal,
            isCutOut
        ),
        frp.map(accum => {
            let brakes;
            if (accum === AscMode.Normal) {
                brakes = AscBrake.None;
            } else if (accum === AscMode.Emergency) {
                brakes = AscBrake.Emergency;
            } else {
                brakes = AscBrake.Penalty;
            }
            return { brakes: brakes };
        })
    );
}

function toOverspeedSetpointMps(aspect: cs.LirrAspect) {
    return (
        {
            [cs.LirrAspect.Speed15]: 17,
            [cs.LirrAspect.Speed30]: 32,
            [cs.LirrAspect.Speed40]: 41,
            [cs.LirrAspect.Speed60]: 64,
            [cs.LirrAspect.Speed70]: 71,
            [cs.LirrAspect.Speed80]: 82,
        }[aspect] * c.mph.toMps
    );
}

function toUnderspeedSetpointMps(aspect: cs.LirrAspect) {
    return (
        {
            [cs.LirrAspect.Speed15]: 15,
            [cs.LirrAspect.Speed30]: 30,
            [cs.LirrAspect.Speed40]: 39,
            [cs.LirrAspect.Speed60]: 62,
            [cs.LirrAspect.Speed70]: 69,
            [cs.LirrAspect.Speed80]: 80,
        }[aspect] * c.mph.toMps
    );
}

function toBrakeAssuranceRateMphS(aspect: cs.LirrAspect, initSpeedMps: number): number | undefined {
    const speedMph = initSpeedMps * c.mps.toMph,
        oneThree = -1.3 * c.mph.toMps,
        oneSeven = -1.7 * c.mph.toMps;
    if (aspect === cs.LirrAspect.Speed15) {
        return undefined;
    } else if (aspect === cs.LirrAspect.Speed30) {
        return speedMph > 29 ? oneSeven : oneThree;
    } else if (aspect === cs.LirrAspect.Speed40) {
        return speedMph > 32 ? oneSeven : oneThree;
    } else if (aspect === cs.LirrAspect.Speed60) {
        return speedMph > 56 ? oneSeven : oneThree;
    } else if (aspect === cs.LirrAspect.Speed70) {
        return speedMph > 60 ? oneSeven : oneThree;
    } else if (aspect === cs.LirrAspect.Speed80) {
        return speedMph > 67 ? oneSeven : oneThree;
    }
}

function toBrakeAssuranceTimeS(aspect: cs.LirrAspect, initSpeedMps: number): number | undefined {
    const speedMph = initSpeedMps * c.mps.toMph;
    if (aspect === cs.LirrAspect.Speed15) {
        return undefined;
    } else if (aspect === cs.LirrAspect.Speed30) {
        return 3;
    } else if (aspect === cs.LirrAspect.Speed40) {
        return speedMph > 32 ? 3 : 3.5;
    } else if (aspect === cs.LirrAspect.Speed60) {
        return speedMph > 56 ? 3 : 5.5;
    } else if (aspect === cs.LirrAspect.Speed70) {
        return speedMph > 60 ? 3 : 6.5;
    } else if (aspect === cs.LirrAspect.Speed80) {
        return speedMph > 67 ? 3 : 7.5;
    }
}
