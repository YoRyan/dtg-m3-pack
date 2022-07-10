/** @noSelfInFile */

import * as frp from "./frp";
import { FrpVehicle, PlayerUpdate } from "./frp-vehicle";
import * as rw from "./railworks";

export class FrpEngine extends FrpVehicle {
    /**
     * Convenient acces to the methods for an engine.
     */
    public eng = new rw.Engine("");

    public playerUpdateWithKey$: frp.Stream<PlayerUpdate>;
    public playerUpdateWithoutKey$: frp.Stream<PlayerUpdate>;
    public customSignalMessage$: frp.Stream<string>;

    private playerUpdateWithKeyNext = (arg0: PlayerUpdate) => {};
    private playerUpdateWithoutKeyNext = (arg0: PlayerUpdate) => {};
    private signalMessageNext = (arg0: string) => {};

    constructor(onInit: () => void) {
        super(onInit);

        this.playerUpdateWithKey$ = frp.hub<PlayerUpdate>()(next => {
            this.playerUpdateWithKeyNext = e => next(e);
        });
        this.playerUpdateWithoutKey$ = frp.hub<PlayerUpdate>()(next => {
            this.playerUpdateWithoutKeyNext = e => next(e);
        });
        this.customSignalMessage$ = frp.hub<string>()(next => {
            this.signalMessageNext = e => next(e);
        });

        this.playerUpdate$(pu => {
            if (this.eng.GetIsEngineWithKey()) {
                this.playerUpdateWithKeyNext(pu);
            } else {
                this.playerUpdateWithoutKeyNext(pu);
            }
        });
    }
    setup() {
        super.setup();

        OnCustomSignalMessage = msg => {
            this.signalMessageNext(msg);
        };
    }
}
