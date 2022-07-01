/** @noSelfInFile */

import * as c from "./constants";
import * as frp from "./frp";
import { FrpEntity, FrpSource } from "./frp-entity";
import { fsm, rejectUndefined } from "./frp-extra";
import * as rw from "./railworks";

const coupleSenseMessage: [message: number, argument: string] = [10001, ""];

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

    private onCvChangeSource = new FrpSource<ControlValueChange>();
    private consistMessageSource = new FrpQueuedSource<ConsistMessage>();
    private vehicleCameraSource = new FrpQueuedSource<VehicleCamera>();

    /**
     * Construct a new rail vehicle.
     * @param onInitAndSettled The callback to run after the game has called
     * Initialise(), and after the control values have settled to their initial
     * values.
     */
    constructor(onInitAndSettled: () => void) {
        // Begin updates, wait 0.5 seconds for the controls to settle, then fire
        // our callback.
        super(() => {
            let done = false;
            this.activateUpdatesEveryFrame(true);
            const wait$ = frp.compose(
                this.createUpdateStream(() => !done),
                fsm(0),
                frp.filter(([from, to]) => from < 0.5 && to >= 0.5)
            );
            wait$(_ => {
                done = true;
                this.activateUpdatesEveryFrame(false);
                onInitAndSettled();
                this.afterInitAndSettled();
            });
        });
    }

    /**
     * Create an event stream that fires for the OnControlValueChange()
     * callback.
     * @returns The new event stream.
     */
    createOnCvChangeStream(): frp.Stream<ControlValueChange> {
        return this.onCvChangeSource.createStream(this.always);
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
     * @returns The new stream of numbers.
     */
    createGetCvStream(name: string, index: number): frp.Stream<number> {
        return frp.compose(
            this.createUpdateStreamForBehavior(() => this.rv.GetControlValue(name, index), this.isPlayer),
            rejectUndefined()
        );
    }

    /**
     * Create an event stream that fires for the OnControlValueChange()
     * callback for a particular control.
     * @param name The name of the control.
     * @param index The index of the control, usually 0.
     * @returns The new stream of values.
     */
    createOnCvChangeStreamFor(name: string, index: number): frp.Stream<number> {
        return frp.compose(
            this.createOnCvChangeStream(),
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
     * @returns The new stream of values.
     */
    createGetCvAndOnCvChangeStreamFor(name: string, index: number): frp.Stream<number> {
        const onUpdate$ = this.createGetCvStream(name, index);
        const onCvChange$ = this.createOnCvChangeStreamFor(name, index);
        return frp.merge<number, number>(onCvChange$)(onUpdate$);
    }

    /**
     * Create an event stream that communicates the current status of the
     * vehicle's front and rear couplers.
     * @returns The new event stream.
     */
    createCouplingsStream(): frp.Stream<VehicleCouplings> {
        return this.createUpdateStreamForBehavior(
            (): VehicleCouplings => [
                this.rv.SendConsistMessage(...coupleSenseMessage, rw.ConsistDirection.Forward),
                this.rv.SendConsistMessage(...coupleSenseMessage, rw.ConsistDirection.Backward),
            ]
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

    setup() {
        super.setup();

        OnControlValueChange = (name, index, value) => {
            this.onCvChangeSource.call([name, index, value]);
            this.updateLoopFromCallback();
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

    protected afterInitAndSettled() {
        this.consistMessageSource.flush();
        this.vehicleCameraSource.flush();
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
