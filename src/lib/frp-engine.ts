/** @noSelfInFile */

import * as frp from "./frp";
import { FrpQueuedSource, FrpVehicle } from "./frp-vehicle";
import * as rw from "./railworks";

export class FrpEngine extends FrpVehicle {
    /**
     * Convenient acces to the methods for an engine.
     */
    public eng = new rw.Engine("");
    /**
     * A behavior that returns true if this is the player-controlled engine.
     */
    public isEngineWithKey: frp.Behavior<boolean> = () => this.eng.GetIsEngineWithKey();

    private signalMessageSource = new FrpQueuedSource<string>();

    /**
     * Create an event stream that fires for the OnCustomSignalMessage()
     * callback.
     * @returns The new event stream.
     */
    createOnCustomSignalMessageStream(): frp.Stream<string> {
        return this.signalMessageSource.createStream(this.always);
    }

    setup() {
        super.setup();

        OnCustomSignalMessage = msg => {
            this.signalMessageSource.call(msg);
            this.updateLoopFromCallback();
        };
    }

    protected afterInit() {
        super.afterInit();

        this.signalMessageSource.flush();
    }
}
