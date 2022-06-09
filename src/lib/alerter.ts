/** @noSelfInFile */
/**
 * Alerter subsystem for the Long Island Rail Road.
 */

import * as frp from "./frp";
import { FrpEngine } from "./frp-engine";
import { foldWithResetBehavior, fsm } from "./frp-extra";
import { VehicleCamera } from "./frp-vehicle";
import * as rw from "./railworks";

export type AlerterState = { brakes: AlerterBrake; alarm: boolean };
export enum AlerterBrake {
    None,
    Penalty,
}
export const initState: AlerterState = { brakes: AlerterBrake.None, alarm: false };
/**
 * Represents the engineer's control inputs to the alerter.
 */
export enum AlerterInput {
    /**
     * Represents actions that inhibit the alerter countdown.
     */
    Activity,
    /**
     * Represents actions that inhibit the alerter countdown and also cancel a
     * penalty application.
     */
    ActivityThatCancelsPenalty,
}

type AlerterUpdate = { deltaS: number };
type AlerterAccum = [AlerterMode.Countdown, number] | [AlerterMode.Alarm, number] | AlerterMode.Penalty;
enum AlerterMode {
    Countdown,
    Alarm,
    Penalty,
}

const countdownS = 25,
    alarmS = 15;

/**
 * Create a new ALE instance.
 * @param e The player's engine.
 * @param input An event stream that represents the engineer's inputs to the
 * alerter.
 * @param cutIn An event stream that indicates the state of the cut in control.
 * @param hasPower A behavior that indicates the unit is powered and keyed in.
 * @returns An event stream that commmunicates all state for this system.
 */
export function create(
    e: FrpEngine,
    input: frp.Stream<AlerterInput>,
    cutIn: frp.Stream<boolean>,
    hasPower: frp.Behavior<boolean>
): frp.Stream<AlerterState> {
    const isPlayerEngine = () => e.eng.GetIsEngineWithKey(),
        cutInOut$ = frp.compose(
            cutIn,
            fsm<boolean>(false),
            frp.filter(([from, to]) => from !== to && frp.snapshot(isPlayerEngine))
        );
    cutInOut$(([, to]) => {
        const msg = to ? "Enabled" : "Disabled";
        rw.ScenarioManager.ShowMessage("ALE Vigilance System", msg, rw.MessageBox.Alert);
    });

    const isCutOut = frp.liftN(
            (cutIn, hasPower, isPlayerEngine) => !(cutIn && hasPower && isPlayerEngine),
            frp.stepper(cutIn, false),
            hasPower,
            isPlayerEngine
        ),
        camera = frp.stepper(e.createCameraStream(), VehicleCamera.FrontCab),
        isExteriorCamera = () => {
            switch (frp.snapshot(camera)) {
                case VehicleCamera.FrontCab:
                case VehicleCamera.RearCab:
                    return false;
                default:
                    return true;
            }
        },
        accumStart: AlerterAccum = [AlerterMode.Countdown, countdownS];
    return frp.compose(
        e.createUpdateStream(),
        fsm(e.e.GetSimulationTime()),
        frp.map<[number, number], AlerterUpdate>(([from, to]) => {
            return { deltaS: to - from };
        }),
        frp.merge(input),
        foldWithResetBehavior<AlerterAccum, AlerterUpdate | AlerterInput>(
            (accum, input) => {
                if (accum === AlerterMode.Penalty) {
                    return input === AlerterInput.ActivityThatCancelsPenalty ? accumStart : AlerterMode.Penalty;
                } else if (
                    input === AlerterInput.Activity ||
                    input === AlerterInput.ActivityThatCancelsPenalty ||
                    frp.snapshot(isExteriorCamera)
                ) {
                    return accumStart;
                } else {
                    const leftS = accum[1] - input.deltaS;
                    if (accum[0] === AlerterMode.Countdown) {
                        return leftS <= 0 ? [AlerterMode.Alarm, alarmS] : [AlerterMode.Countdown, leftS];
                    } else {
                        return leftS <= 0 ? AlerterMode.Penalty : [AlerterMode.Alarm, leftS];
                    }
                }
            },
            accumStart,
            isCutOut
        ),
        frp.map((accum): AlerterState => {
            return {
                brakes: accum === AlerterMode.Penalty ? AlerterBrake.Penalty : AlerterBrake.None,
                alarm: accum === AlerterMode.Penalty || accum[0] === AlerterMode.Alarm,
            };
        })
    );
}
