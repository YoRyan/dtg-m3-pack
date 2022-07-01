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
import { fsm } from "./frp-extra";
import * as rw from "./railworks";

export type AscState = {
    brakes: AscBrake;
    alarm: boolean;
    overspeed: boolean;
    atcForestall: boolean;
    brakeAssurance: boolean;
};
export enum AscBrake {
    None,
    Penalty,
    MaxService,
    Emergency,
}
export const initState: AscState = {
    brakes: AscBrake.None,
    alarm: false,
    overspeed: false,
    atcForestall: false,
    brakeAssurance: false,
};

type AscAccum =
    | AscMode.Normal
    | [mode: AscMode.Downgrade, stopwatchS: number, acknowledged: boolean]
    | [
          mode: AscMode.Overspeed,
          initAspect: cs.LirrAspect,
          initSpeedMps: number,
          stopwatchS: number,
          acknowledged: boolean
      ]
    | AscMode.Emergency;
enum AscMode {
    Normal,
    Downgrade,
    Overspeed,
    Emergency,
}

type AscEvent =
    | [type: AscEventType.Update, deltaS: number]
    | AscEventType.Reset
    | [type: AscEventType.Overspeed, initAspect: cs.LirrAspect, initSpeedMps: number]
    | AscEventType.Downgrade;
enum AscEventType {
    Update,
    Reset,
    Downgrade,
    Overspeed,
}

const popupS = 5;
const downgradePenaltyS = 7;
const downgradeMaxServiceS = 14;
const downgradeEmergencyS = 21;

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
    cabAspect: frp.Stream<cs.LirrAspect>,
    acknowledge: frp.Behavior<boolean>,
    coastOrBrake: frp.Behavior<boolean>,
    cutIn: frp.Stream<boolean>,
    hasPower: frp.Behavior<boolean>
): frp.Stream<AscState> {
    const cutInOut$ = frp.compose(
        cutIn,
        frp.filter(_ => frp.snapshot(e.isEngineWithKey)),
        fsm(false),
        frp.filter(([from, to]) => from !== to)
    );
    cutInOut$(([, to]) => {
        const msg = to ? "Enabled" : "Disabled";
        rw.ScenarioManager.ShowAlertMessageExt("ASC Signal Speed Enforcement", msg, popupS, "");
    });

    const isActive = frp.liftN(
        (cutIn, hasPower, isPlayerEngine) => cutIn && hasPower && isPlayerEngine,
        frp.stepper(cutIn, false),
        hasPower,
        e.isEngineWithKey
    );
    const reset$ = frp.compose(
        e.createUpdateStreamForBehavior(isActive, e.isEngineWithKey),
        frp.filter(active => !active),
        frp.map((_): AscEvent => AscEventType.Reset)
    );

    const aSpeedMps = () => Math.abs(e.rv.GetControlValue("SpeedometerMPH", 0) as number) * c.mph.toMps;
    const accelMphS = () => e.rv.GetAcceleration() * c.mps.toMph;
    const theCabAspect = frp.stepper(cabAspect, cs.LirrAspect.Speed15);
    const isOverspeed = frp.liftN(
        (speedMps, cabAspect, active) => active && speedMps > toOverspeedSetpointMps(cabAspect),
        aSpeedMps,
        theCabAspect,
        isActive
    );
    const overspeed$ = frp.compose(
        e.createUpdateStreamForBehavior(isOverspeed, isActive),
        fsm(false),
        frp.filter(([from, to]) => !from && to),
        frp.map((_): AscEvent => [AscEventType.Overspeed, frp.snapshot(theCabAspect), frp.snapshot(aSpeedMps)])
    );
    const downgrade$ = frp.compose(
        cabAspect,
        fsm(cs.LirrAspect.Speed15),
        frp.filter(([from, to]) => (to as number) < (from as number)),
        frp.map((_): AscEvent => AscEventType.Downgrade)
    );
    return frp.compose(
        e.createUpdateDeltaStream(isActive),
        frp.map((dt): AscEvent => [AscEventType.Update, dt]),
        frp.merge(reset$),
        frp.merge(overspeed$),
        frp.merge(downgrade$),
        frp.fold<AscAccum, AscEvent>((accum, event) => {
            // Handle reset events (and other events while in the inactive state).
            if (!frp.snapshot(isActive) || event === AscEventType.Reset) {
                return AscMode.Normal;
            }

            const stopped = frp.snapshot(aSpeedMps) < c.stopSpeed;

            if (accum === AscMode.Emergency) {
                // Emergency braking; stay until the train has stopped.
                return frp.snapshot(acknowledge) && frp.snapshot(coastOrBrake) && stopped
                    ? AscMode.Normal
                    : AscMode.Emergency;
            }

            if (accum === AscMode.Normal) {
                if (event === AscEventType.Downgrade) {
                    // Move to the downgrade state.
                    return [AscMode.Downgrade, 0, false];
                }

                const [e] = event;
                if (e === AscEventType.Overspeed) {
                    // Move to the overspeed state.
                    const [, initAspect, initSpeedMps] = event;
                    return [AscMode.Overspeed, initAspect, initSpeedMps, 0, false];
                }

                // Just a clock update; do nothing.
                return accum;
            }

            // Downgrade state
            const [mode] = accum;
            if (mode === AscMode.Downgrade) {
                if (event === AscEventType.Downgrade) {
                    // Already in the downgrade state; do nothing.
                    return accum;
                }

                const [e] = event;
                if (e === AscEventType.Overspeed) {
                    // An overspeed overrides the downgrade timer.
                    const [, initAspect, initSpeedMps] = event;
                    return [AscMode.Overspeed, initAspect, initSpeedMps, 0, false];
                }

                // Clock update; move to another state if warranted, or add
                // time to the stopwatch.
                const [, stopwatchS, ack] = accum;
                if (ack) {
                    return AscMode.Normal;
                } else if (stopwatchS > downgradeEmergencyS) {
                    return AscMode.Emergency;
                }
                const [, dt] = event;
                return [AscMode.Downgrade, stopwatchS + dt, frp.snapshot(acknowledge) || ack];
            }

            // Overspeed state
            {
                if (event === AscEventType.Downgrade) {
                    // The overspeed state ignores downgrades.
                    return accum;
                }

                const [e] = event;
                if (e === AscEventType.Overspeed) {
                    // Ignore additional overspeed events, which are likely
                    // redundant.
                    return accum;
                }

                // Clock update; move to another state if warranted, or trip
                // the acknowledgement flag and add time to the stopwatch.
                const [, initAspect, initSpeedMps, stopwatchS, ack] = accum;
                const underSpeed = frp.snapshot(aSpeedMps) < toUnderspeedSetpointMps(frp.snapshot(theCabAspect));
                const acked = ack || frp.snapshot(acknowledge);
                if (underSpeed && acked && frp.snapshot(coastOrBrake)) {
                    // Penalty acknowledged and we are under-speed.
                    return AscMode.Normal;
                }

                // Brake assurance rate check
                const brakeAssuranceRateMphS = toBrakeAssuranceRateMphS(initAspect, initSpeedMps);
                const brakeAssuranceTimeS = toBrakeAssuranceTimeS(initAspect, initSpeedMps);
                const isBrakeAssurance =
                    brakeAssuranceRateMphS !== undefined
                        ? frp.snapshot(accelMphS) < brakeAssuranceRateMphS || stopped
                        : true;
                if (brakeAssuranceTimeS !== undefined && stopwatchS > brakeAssuranceTimeS && !isBrakeAssurance) {
                    // Brake assurance timer has elapsed; apply emergency
                    // braking.
                    return AscMode.Emergency;
                } else {
                    // Update stopwatch and acknowledgement states.
                    const [, dt] = event;
                    return [AscMode.Overspeed, initAspect, initSpeedMps, stopwatchS + dt, acked];
                }
            }
        }, AscMode.Normal),
        frp.map(accum => {
            if (accum === AscMode.Normal) {
                return {
                    brakes: AscBrake.None,
                    alarm: false,
                    overspeed: false,
                    atcForestall: false,
                    brakeAssurance: false,
                };
            }

            if (accum === AscMode.Emergency) {
                return {
                    brakes: AscBrake.Emergency,
                    alarm: true,
                    overspeed: false,
                    atcForestall: false,
                    brakeAssurance: false,
                };
            }

            // Downgrade state
            const [mode] = accum;
            if (mode === AscMode.Downgrade) {
                const [, stopwatchS] = accum;
                let brakes;
                if (stopwatchS > downgradeMaxServiceS) {
                    brakes = AscBrake.MaxService;
                } else if (stopwatchS > downgradePenaltyS) {
                    brakes = AscBrake.Penalty;
                } else {
                    brakes = AscBrake.None;
                }
                return {
                    brakes: brakes,
                    alarm: true,
                    overspeed: false,
                    atcForestall: false,
                    brakeAssurance: false,
                };
            }

            // Overspeed state
            const [, initAspect, initSpeedMps, , ack] = accum;
            const brakeAssuranceRateMphS = toBrakeAssuranceRateMphS(initAspect, initSpeedMps);
            const isBrakeAssurance =
                brakeAssuranceRateMphS !== undefined ? frp.snapshot(accelMphS) < brakeAssuranceRateMphS : true;
            const satisfied = isBrakeAssurance && ack && frp.snapshot(coastOrBrake);
            return {
                brakes: AscBrake.Penalty,
                alarm: !satisfied,
                overspeed: frp.snapshot(aSpeedMps) > toUnderspeedSetpointMps(initAspect),
                atcForestall: satisfied,
                brakeAssurance: isBrakeAssurance,
            };
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
    const speedMph = initSpeedMps * c.mps.toMph;
    const oneThree = -1.3 * c.mph.toMps;
    const oneSeven = -1.7 * c.mph.toMps;
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
