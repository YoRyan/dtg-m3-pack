/** @noSelfInFile */

import * as c from "./constants";
import * as frp from "./frp";
import { FrpEntity, FrpSource } from "./frp-entity";
import { fsm, rejectUndefined } from "./frp-extra";
import * as rw from "./railworks";

/**
 * Indicates whether the rail vehicle's front and/or rear couplers are engaged.
 */
export type VehicleCouplings = [front: boolean, rear: boolean];

/**
 * Indicates whether the rail vehicle is controlled by the player or by the AI.
 */
export enum VehicleAuthority {
    /**
     * This rail vehicle is part of the player train.
     */
    IsPlayer,
    /**
     * This rail vehicle is part of an AI train that has not moved.
     */
    IsAiParked,
    /**
     * This rail vehicle is part of an AI train and it is moving in the forward
     * direction (unless it is flipped, in which case it is reversing).
     */
    IsAiMovingForward,
    /**
     * This rail vehicle is part of an AI train and it is moving in the reverse
     * direction (unless it is flipped, in which case it is moving forward).
     */
    IsAiMovingBackward,
}

/**
 * Represents an OnControlValueChange() event.
 */
export type ControlValueChange = [name: string, index: number, value: number];

/**
 * Represents an OnConsistMessage() event.
 */
export type ConsistMessage = [id: number, content: string, direction: rw.ConsistDirection];

/**
 * Represents the state of the camera view passed to OnCameraEnter() and
 * OnCameraLeave().
 */
export enum VehicleCamera {
    Outside,
    Carriage,
    FrontCab,
    RearCab,
}

enum SensedDirection {
    Backward,
    None,
    Forward,
}

type CouplingsAccum = undefined | { nextUpdateS: number; sensed: VehicleCouplings };
const coupleSenseMessage: [message: number, argument: string] = [10001, ""];
const maxCouplingUpdateS = 5;

/**
 * A rail vehicle is a scripted entity that has control values, a physics
 * simulation, and callbacks to track simulator state and the player's actions.
 */
export class FrpVehicle extends FrpEntity {
    /**
     * Convenient access to the methods for a rail vehicle.
     */
    public rv = new rw.RailVehicle("");
    /**
     * A behavior that returns true if this vehicle is part of the player
     * train.
     */
    public isPlayer: frp.Behavior<boolean> = () => this.rv.GetIsPlayer();
    /**
     * A behavior that returns true if the controls have settled after initial
     * startup.
     */
    public areControlsSettled: frp.Behavior<boolean> = () =>
        this.initTimeS === undefined ? false : this.e.GetSimulationTime() > this.initTimeS + 0.5;

    private initTimeS: number | undefined = undefined;
    private onCvChangeSource = new FrpSource<ControlValueChange>();
    private consistMessageSource = new FrpQueuedSource<ConsistMessage>();
    private vehicleCameraSource = new FrpQueuedSource<VehicleCamera>();

    /**
     * Construct a new rail vehicle.
     * @param onInit The callback to run after the game has called
     * Initialise().
     */
    constructor(onInit: () => void) {
        super(() => {
            onInit();
            this.afterInit();
        });
    }

    /**
     * Create an event stream that fires for the OnControlValueChange()
     * callback.
     * @param guard The stream will produce events as long as this behavior is
     * true. Defaults to after the control values have settled.
     * @returns The new event stream.
     */
    createOnCvChangeStream(guard = this.areControlsSettled): frp.Stream<ControlValueChange> {
        return this.onCvChangeSource.createStream(guard);
    }

    /**
     * Create an event stream that fires for the OnConsistMessage() callback.
     * @returns The new event stream.
     */
    createOnConsistMessageStream(): frp.Stream<ConsistMessage> {
        return this.consistMessageSource.createStream(this.always);
    }

    /**
     * Create an event stream that fires for the OnConsistMessage() callback
     * for a particular type of message.
     * @param id The message ID to filter for.
     * @returns The new event stream.
     */
    createOnConsistMessageStreamFor(id: number): frp.Stream<[content: string, direction: rw.ConsistDirection]> {
        return frp.compose(
            this.createOnConsistMessageStream(),
            frp.filter(([msgId]) => msgId === id),
            frp.map(([, content, dir]) => [content, dir])
        );
    }

    /**
     * Create an event stream that tracks the current camera view through the
     * OnCameraEnter() and OnCameraLeave() callbacks.
     * @returns The new event stream.
     */
    createCameraStream(): frp.Stream<VehicleCamera> {
        return this.vehicleCameraSource.createStream(this.always);
    }

    /**
     * Create a continuously updating stream of controlvalues. Nil values are
     * filtered out, so nonexistent controlvalues will simply never fire their
     * callbacks.
     * @param name The name of the controlvalue.
     * @param index The index of the controlvalue, usually 0.
     * @param guard The stream will produce events as long as this behavior is
     * true. Defaults to after the control values have settled.
     * @returns The new stream of numbers.
     */
    createGetCvStream(name: string, index: number, guard = this.areControlsSettled): frp.Stream<number> {
        return frp.compose(
            this.createUpdateStreamForBehavior(() => this.rv.GetControlValue(name, index), guard),
            rejectUndefined()
        );
    }

    /**
     * Create an event stream that fires for the OnControlValueChange()
     * callback for a particular control.
     * @param name The name of the control.
     * @param index The index of the control, usually 0.
     * @param guard The stream will produce events as long as this behavior is
     * true. Defaults to after the control values have settled.
     * @returns The new stream of values.
     */
    createOnCvChangeStreamFor(name: string, index: number, guard = this.areControlsSettled): frp.Stream<number> {
        return frp.compose(
            this.createOnCvChangeStream(guard),
            frp.filter(([cvcName, cvcIndex]) => cvcName === name && cvcIndex === index),
            frp.map(([, , value]) => value)
        );
    }

    /**
     * Create a continuously updating stream of controlvalues that also fires
     * for the OnControlValueChange() callback. This is the closest a script
     * can get to intercepting every possible change of the controlvalue.
     * @param name The name of the control.
     * @param index The index of the control, usually 0.
     * @param guard The stream will produce events as long as this behavior is
     * true.
     * @returns The new stream of values.
     */
    createGetCvAndOnCvChangeStreamFor(
        name: string,
        index: number,
        guard = this.areControlsSettled
    ): frp.Stream<number> {
        const onUpdate$ = this.createGetCvStream(name, index, guard);
        const onCvChange$ = this.createOnCvChangeStreamFor(name, index, guard);
        return frp.merge<number, number>(onCvChange$)(onUpdate$);
    }

    /**
     * Create an event stream that communicates the current status of the
     * vehicle's front and rear couplers.
     * @returns The new event stream.
     */
    createCouplingsStream(): frp.Stream<VehicleCouplings> {
        return frp.compose(
            this.createUpdateStream(),
            frp.fold<CouplingsAccum, number>((accum, t) => {
                // AI trains don't couple, so we don't need to probe them again.
                if (accum === undefined || (t > accum.nextUpdateS && this.rv.GetIsPlayer())) {
                    const nextUpdateS = t + Math.random() * maxCouplingUpdateS;
                    const sensed: VehicleCouplings = [
                        this.rv.SendConsistMessage(...coupleSenseMessage, rw.ConsistDirection.Forward),
                        this.rv.SendConsistMessage(...coupleSenseMessage, rw.ConsistDirection.Backward),
                    ];
                    return { nextUpdateS, sensed };
                } else {
                    return accum;
                }
            }, undefined),
            frp.map(accum => accum?.sensed ?? [false, false])
        );
    }

    /**
     * Create an event stream that commmunicates who is controlling the vehicle
     * and in what manner they are doing so.
     * @returns The new event stream.
     */
    createAuthorityStream(): frp.Stream<VehicleAuthority> {
        return frp.compose(
            this.createUpdateStreamForBehavior(() => this.rv.GetSpeed()),
            frp.fold((dir, speed) => {
                if (speed > c.stopSpeed) {
                    return SensedDirection.Forward;
                } else if (speed < -c.stopSpeed) {
                    return SensedDirection.Backward;
                } else {
                    return dir;
                }
            }, SensedDirection.None),
            frp.map(direction =>
                frp.snapshot(this.isPlayer)
                    ? VehicleAuthority.IsPlayer
                    : {
                          [SensedDirection.Forward]: VehicleAuthority.IsAiMovingForward,
                          [SensedDirection.None]: VehicleAuthority.IsAiParked,
                          [SensedDirection.Backward]: VehicleAuthority.IsAiMovingBackward,
                      }[direction]
            )
        );
    }

    /**
     * Like the ordinary fold(), except this version takes a behavior that
     * returns the initial value, and does not produce events until the
     * controls have settled.
     */
    foldAfterSettled<TAccum, TValue>(
        step: (accumulated: TAccum, value: TValue) => TAccum,
        initial: frp.Behavior<TAccum>
    ): (eventStream: frp.Stream<TValue>) => frp.Stream<TAccum> {
        return eventStream => {
            return next => {
                let accumulated = frp.snapshot(initial);
                let firstRead = false;
                eventStream(value => {
                    if (frp.snapshot(this.areControlsSettled) && firstRead) {
                        next((accumulated = step(accumulated, value)));
                    } else {
                        accumulated = frp.snapshot(initial);
                        firstRead = true;
                    }
                });
            };
        };
    }

    setup() {
        super.setup();

        OnControlValueChange = (name, index, value) => {
            this.onCvChangeSource.call([name, index, value]);
        };
        OnConsistMessage = (id, content, dir) => {
            this.consistMessageSource.call([id, content, dir]);
            this.updateLoopFromCallback();
        };
        OnCameraEnter = (cabEnd, carriageCam) => {
            let vc;
            if (carriageCam === rw.CameraEnterView.Cab) {
                vc = cabEnd === rw.CameraEnterCabEnd.Rear ? VehicleCamera.RearCab : VehicleCamera.FrontCab;
            } else {
                vc = VehicleCamera.Carriage;
            }
            this.vehicleCameraSource.call(vc);
            this.updateLoopFromCallback();
        };
        OnCameraLeave = () => {
            this.vehicleCameraSource.call(VehicleCamera.Outside);
            this.updateLoopFromCallback();
        };
    }

    protected afterInit() {
        this.initTimeS = this.e.GetSimulationTime();
        this.consistMessageSource.flush();
        this.vehicleCameraSource.flush();
    }

    protected updateLoop() {
        // To save frames, don't update AI trains that are far away from the
        // camera.
        if (!this.rv.GetIsPlayer()) {
            const [x, y, z] = this.rv.getNearPosition();
            const distanceM2 = x * x + y * y + z + z;
            const thresholdM = 2 * c.mi.toKm * 1000;
            if (distanceM2 > thresholdM * thresholdM) {
                return;
            }
        }
        super.updateLoop();
    }
}

/**
 * A queue for FrpSource that stores events that happen before the
 * initialize-and-wait phase has completed. Upon initialization, the queue is
 * flushed.
 */
export class FrpQueuedSource<T> {
    private source = new FrpSource<T>();
    private queue: T[] | undefined = [];

    /**
     * Create a new event stream and register its callback to the underlying
     * stream source.
     * @param guard The event stream will only produce events while this
     * behavior is true.
     */
    createStream(guard: frp.Behavior<boolean>): frp.Stream<T> {
        return this.source.createStream(guard);
    }

    /**
     * Queue the provided value, or if the queue has already been flushed, call
     * the callbacks in the underlying stream source with the provided value.
     * @param value The value.
     */
    call(value: T) {
        if (this.queue !== undefined) {
            this.queue.push(value);
        } else {
            this.source.call(value);
        }
    }

    /**
     * Flush all values from the queue and, henceforth, pass values directly to
     * the underlying stream source.
     */
    flush() {
        if (this.queue !== undefined) {
            for (const value of this.queue) {
                this.source.call(value);
            }
            this.queue = undefined;
        }
    }
}
