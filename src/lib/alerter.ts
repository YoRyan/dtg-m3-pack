/** @noSelfInFile */
/**
 * Alerter subsystem for the Long Island Rail Road.
 */

import * as frp from "./frp";
import { FrpEngine } from "./frp-engine";
import { fsm } from "./frp-extra";
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

type AlerterEvent = [type: AlerterEventType.Update, deltaS: number] | AlerterEventType.Reset | AlerterInput;
enum AlerterEventType {
    Update,
    Reset,
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
    const isEngineWithKeyAndSettled = frp.liftN(
        (engineWithKey, controlsSettled) => engineWithKey && controlsSettled,
        e.isEngineWithKey,
        e.areControlsSettled
    );
    const cutInOut$ = frp.compose(
        e.createUpdateStreamForBehavior(cutIn, isEngineWithKeyAndSettled),
        fsm<undefined | boolean>(undefined),
        // Cut in streams tend to start in false and then go to true, regardless
        // of the control value settle delay, so ignore that first transition.
        frp.filter(([from, to]) => from !== to && !(from === undefined && !to))
    );
    cutInOut$(([, to]) => {
        const msg = to ? "Enabled" : "Disabled";
        rw.ScenarioManager.ShowAlertMessageExt("ALE Vigilance System", msg, popupS, "");
    });

    const isActive = frp.liftN(
        (cutIn, hasPower, isPlayerEngine) => cutIn && hasPower && isPlayerEngine,
        cutIn,
        hasPower,
        e.isEngineWithKey
    );
    const reset$ = frp.compose(
        e.createUpdateStreamForBehavior(isActive, e.isEngineWithKey),
        frp.filter(active => !active),
        frp.map((_): AlerterEvent => AlerterEventType.Reset)
    );

    const camera = frp.stepper(e.createCameraStream(), VehicleCamera.FrontCab);
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
        e.createUpdateDeltaStream(isActive),
        frp.map((dt): AlerterEvent => [AlerterEventType.Update, dt]),
        frp.merge(input),
        frp.merge(reset$),
        frp.fold<AlerterAccum, AlerterEvent>((accum, event) => {
            // Handle reset events (and other events while in the inactive state).
            if (!frp.snapshot(isActive) || event === AlerterEventType.Reset) {
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
