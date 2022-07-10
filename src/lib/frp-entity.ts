/** @noSelfInFile */

import * as frp from "./frp";
import * as rw from "./railworks";

/**
 * An entity is a world object that can request an Update() call. It manages an
 * update loop that runs on every Update() or event callback.
 */
export class FrpEntity {
    /**
     * Convenient access to the methods for a scripted entity.
     */
    public e = new rw.ScriptedEntity("");

    public update$: frp.Stream<number>;

    private updateNext = (arg0: number) => {};
    private onInit: (this: void) => void;
    private updatingEveryFrame = false;

    /**
     * Construct a new entity.
     * @param onInit The callback to run when the game calls Initialise().
     */
    constructor(onInit: () => void) {
        this.update$ = frp.hub<number>()(next => {
            this.updateNext = e => next(e);
        });
        this.onInit = onInit;
    }

    /**
     * Set the global callback functions to execute this entity.
     */
    setup() {
        Initialise = this.onInit;
        Update = dt => {
            this.updateNext(dt);
            if (!this.updatingEveryFrame) {
                // EndUpdate() must be called from the Update() callback.
                this.e.EndUpdate();
            }
        };
    }

    /**
     * Set the update loop to update every frame, or only upon the execution of
     * any callback.
     * @param everyFrame Whether to update every frame.
     */
    activateUpdatesEveryFrame(everyFrame: boolean) {
        if (!this.updatingEveryFrame && everyFrame) {
            this.e.BeginUpdate();
        }
        this.updatingEveryFrame = everyFrame;
    }
}
