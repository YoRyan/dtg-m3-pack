/** @noSelfInFile */
/**
 * A control for the destination boards selected by the first character of the
 * rail vehicle number.
 */

import * as frp from "./frp";
import { FrpVehicle } from "./frp-vehicle";
import * as rw from "./railworks";

const destinationMessageId = 10002;
const popupS = 3;
const popupItems = 5;

export type Destination = [character: string, name: string];

/**
 * Set up the destination board controller, and send and receive destination
 * selection messages across the consist.
 * @param v The rail vehicle.
 * @param destinations A list of all destinations.
 * @param previous A stream that selects the previous destination.
 * @param next A stream that selects the next destination.
 */
export function setup(v: FrpVehicle, destinations: Destination[], previous: frp.Stream<any>, next: frp.Stream<any>) {
    const nDest = destinations.length;
    const currentIndex = () => getMyDestinationIndex(v, destinations);
    const movePrevious$ = frp.compose(
        previous,
        frp.map(_ => -1)
    );
    const moveNext$ = frp.compose(
        next,
        frp.map(_ => 1)
    );
    const move$ = frp.compose(
        movePrevious$,
        frp.merge(moveNext$),
        frp.map(move => Math.max(Math.min(frp.snapshot(currentIndex) + move, destinations.length - 1), 0)),
        // Popups should always show groups of 5 items. If at either end of the
        // "menu," we should add or subtract an offset to keep showing 5 items.
        frp.fold<[offset: number, selected: number], number>(
            ([lastOffset], selected) => {
                let offset;
                if (nDest <= popupItems) {
                    offset = 0;
                } else if (selected >= Math.floor(nDest / popupItems) * popupItems) {
                    offset = Math.max(lastOffset, (selected + 1) % popupItems);
                } else {
                    offset = Math.min(lastOffset, selected);
                }
                return [offset, selected];
            },
            [0, 0]
        )
    );
    move$(([offset, selected]) => {
        // Show a popup with the selected destination and the ones adjacent to it.
        const lines: string[] = [];
        for (let i = 0; i < popupItems; i++) {
            const window = Math.floor((selected - offset) / popupItems);
            const idx = window * popupItems + offset + i;
            if (idx >= nDest) {
                break;
            } else {
                const [, name] = destinations[idx];
                lines.push(idx === selected ? `> ${name} <` : name);
            }
        }
        rw.ScenarioManager.ShowInfoMessageExt(
            "Change Destination Boards",
            lines.join("\n"),
            popupS,
            rw.MessageBoxPosition.Centre,
            rw.MessageBoxSize.Small,
            false
        );
        // Set the rail vehicle number and broadcast to the rest of the consist.
        const [char] = destinations[selected];
        setMyDestinationChar(v, char);
        sendDestinationChar(v, char);
    });
    // Handle consist messages.
    const consistMessage$ = frp.compose(
        v.consistMessage$,
        frp.filter(([id]) => id === destinationMessageId)
    );
    consistMessage$(([, content, dir]) => {
        setMyDestinationChar(v, content);
        v.rv.SendConsistMessage(destinationMessageId, content, dir);
    });
}

function getMyDestinationIndex(v: FrpVehicle, destinations: Destination[]) {
    const number = v.rv.GetRVNumber();
    const character = string.sub(number, 1, 1);
    let idx = 0;
    destinations.forEach(([char], i) => {
        if (char === character) {
            idx = i;
        }
    });
    return idx;
}

function setMyDestinationChar(v: FrpVehicle, character: string) {
    const number = v.rv.GetRVNumber();
    v.rv.SetRVNumber(character + string.sub(number, 2));
}

function sendDestinationChar(v: FrpVehicle, character: string) {
    v.rv.SendConsistMessage(destinationMessageId, character, rw.ConsistDirection.Backward);
    v.rv.SendConsistMessage(destinationMessageId, character, rw.ConsistDirection.Forward);
}
