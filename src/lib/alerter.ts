/** @noSelfInFile */
/**
 * Alerter subsystem for the Long Island Rail Road.
 */

import * as frp from "./frp";
import { FrpEngine } from "./frp-engine";
import { fsm, mapBehavior } from "./frp-extra";
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

type AlerterAccum = [AlerterMode.Countdown, number] | [AlerterMode.Alarm, number] | AlerterMode.Penalty;
enum AlerterMode {
    Countdown,
    Alarm,
    Penalty,
}

type AlerterEvent = [type: AlerterEventType.Update, deltaS: number] | AlerterInput;
enum AlerterEventType {
    Update,
}

const popupS = 5;
const countdownS = 25;
const alarmS = 15;

/**
 * Create a new ALE instance.
 * @param e The player's engine.
 * @param input An event stream that represents the engineer's inputs to the
 * alerter.
 * @param cutIn An behavior that indicates the state of the cut in control.
 * @param hasPower A behavior that indicates the unit is powered and keyed in.
 * @returns An event stream that commmunicates all state for this system.
 */
export function create(
    e: FrpEngine,
    input: frp.Stream<AlerterInput>,
    cutIn: frp.Behavior<boolean>,
    hasPower: frp.Behavior<boolean>
): frp.Stream<AlerterState> {
    const cutInOut$ = frp.compose(
        e.playerUpdateWithKey$,
        frp.filter(_ => frp.snapshot(e.areControlsSettled)),
        mapBehavior(cutIn),
        fsm<undefined | boolean>(undefined),
        // Cut in streams tend to start in false and then go to true, regardless
        // of the control value settle delay, so ignore that first transition.
        frp.filter(([from, to]) => from !== to && !(from === undefined && !to))
    );
    cutInOut$(([, to]) => {
        const msg = to ? "Enabled" : "Disabled";
        rw.ScenarioManager.ShowAlertMessageExt("ALE Vigilance System", msg, popupS, "");
    });

    const camera = frp.stepper(e.vehicleCamera$, VehicleCamera.FrontCab);
    const isExteriorCamera = () => {
        switch (frp.snapshot(camera)) {
            case VehicleCamera.FrontCab:
            case VehicleCamera.RearCab:
                return false;
            default:
                return true;
        }
    };

    const accumStart: AlerterAccum = [AlerterMode.Countdown, countdownS];
    return frp.compose(
        e.playerUpdateWithKey$,
        frp.map((pu): AlerterEvent => [AlerterEventType.Update, pu.dt]),
        frp.merge(input),
        frp.fold<AlerterAccum, AlerterEvent>((accum, event) => {
            if (!(frp.snapshot(cutIn) && frp.snapshot(hasPower))) {
                return accumStart;
            }

            if (accum === AlerterMode.Penalty) {
                return event === AlerterInput.ActivityThatCancelsPenalty ? accumStart : AlerterMode.Penalty;
            } else if (
                event === AlerterInput.Activity ||
                event === AlerterInput.ActivityThatCancelsPenalty ||
                frp.snapshot(isExteriorCamera)
            ) {
                return accumStart;
            } else {
                const [, accumS] = accum;
                const [, dt] = event;
                const leftS = accumS - dt;
                if (accum[0] === AlerterMode.Countdown) {
                    return leftS <= 0 ? [AlerterMode.Alarm, alarmS] : [AlerterMode.Countdown, leftS];
                } else {
                    return leftS <= 0 ? AlerterMode.Penalty : [AlerterMode.Alarm, leftS];
                }
            }
        }, accumStart),
        frp.map(accum => {
            return {
                brakes: accum === AlerterMode.Penalty ? AlerterBrake.Penalty : AlerterBrake.None,
                alarm: accum === AlerterMode.Penalty || accum[0] === AlerterMode.Alarm,
            };
        })
    );
}
