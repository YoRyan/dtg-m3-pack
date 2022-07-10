/** @noSelfInFile */
/**
 * Advanced Civil Speed Enforcement System for the Long Island Rail Road.
 */

import * as cs from "./cabsignals";
import * as c from "./constants";
import * as frp from "./frp";
import { FrpEngine } from "./frp-engine";
import { fsm, mapBehavior, rejectUndefined } from "./frp-extra";
import { PlayerUpdate } from "./frp-vehicle";
import * as rw from "./railworks";

export type AcsesState = { brakes: AcsesBrake; alarm: boolean; overspeed: boolean; trackSpeed: AcsesTrack };
export enum AcsesBrake {
    None,
    Penalty,
    PositiveStop,
}
export type AcsesTrack = AcsesSpeed.CutOut | AcsesSpeed.Degraded | [mode: AcsesSpeed.Enforcing, speedMps: number];
export enum AcsesSpeed {
    Enforcing,
    CutOut,
    Degraded,
}

type AcsesAccum = {
    acknowledged: Set<Hazard>;
    mode: AcsesMode;
    inForce: Hazard;
    trackSpeed: AcsesTrack;
};
type AcsesMode =
    | AcsesModeType.Normal
    | [mode: AcsesModeType.Alert, stopwatchS: number, acknowledge: boolean]
    | [mode: AcsesModeType.Penalty, acknowledge: boolean];
enum AcsesModeType {
    Normal,
    Alert,
    Penalty,
}

type AcsesEvent = [type: AcsesEventType.Update, deltaS: number] | AcsesEventType.Downgrade;
enum AcsesEventType {
    Update,
    Downgrade,
}

/**
 * Distance traveled since the last search along with a collection of
 * statelessly sensed objects.
 */
type Reading<T> = [traveledM: number, sensed: Sensed<T>[]];
/**
 * A distance relative to the rail vehicle along with the object sensed.
 */
type Sensed<T> = [distanceM: number, object: T];
type SpeedPost = { type: rw.SpeedLimitType; speedMps: number };
type TwoSidedSpeedPost = { before: SpeedPost | undefined; after: SpeedPost | undefined };
type Signal = { proState: rw.ProSignalState };
type HazardsAccum = { advanceLimits: Map<number, AdvanceLimitHazard>; hazards: Hazard[] };
type ObjectIndexAccum<T> = { counter: number; sensed: Map<number, Sensed<T>>; passing: Map<number, Sensed<T>> };

const popupS = 5;
const alertMarginMps = 3 * c.mph.toMps;
const penaltyMarginMps = 6 * c.mph.toMps;
const alertCountdownS = 6;
const penaltyCurveMps2 = -1 * c.mph.toMps;
const iterateStepM = 0.01;
const hugeSpeed = 999;

/**
 * Create a new ACSES instance.
 * @param e The player's engine.
 * @param acknowledge A behavior that indicates the state of the acknowledge
 * joystick.
 * @param coastOrBrake A behavior that indicates the master controller has been
 * placed into a braking or the coast position.
 * @param cutIn An behavior that indicates the state of the cut in control.
 * @param hasPower A behavior that indicates the unit is powered and keyed in.
 * @returns An event stream that commmunicates all state for this system.
 */
export function create(
    e: FrpEngine,
    acknowledge: frp.Behavior<boolean>,
    coastOrBrake: frp.Behavior<boolean>,
    cutIn: frp.Behavior<boolean>,
    hasPower: frp.Behavior<boolean>
): frp.Stream<AcsesState> {
    const cutInOut$ = frp.compose(
        e.createPlayerWithKeyUpdateStream(),
        frp.filter(_ => frp.snapshot(e.areControlsSettled)),
        mapBehavior(cutIn),
        fsm<undefined | boolean>(undefined),
        // Cut in streams tend to start in false and then go to true, regardless
        // of the control value settle delay, so ignore that first transition.
        frp.filter(([from, to]) => from !== to && !(from === undefined && !to))
    );
    cutInOut$(([, to]) => {
        const msg = to ? "Enabled" : "Disabled";
        rw.ScenarioManager.ShowAlertMessageExt("ACSES Track Speed Enforcement", msg, popupS, "");
    });

    const isActive = frp.liftN((cutIn, hasPower) => cutIn && hasPower, cutIn, hasPower);
    const isInactive = frp.liftN(isActive => !isActive, isActive);
    const speedMps = () => (e.rv.GetControlValue("SpeedometerMPH", 0) as number) * c.mph.toMps;

    const pts$ = frp.compose(
        e.createOnSignalMessageStream(),
        frp.map(msg => cs.toPositiveStopDistanceM(msg)),
        rejectUndefined()
    );
    const pts = frp.stepper(pts$, false);

    const speedPostIndex$ = frp.compose(
        e.createPlayerWithKeyUpdateStream(),
        mapSpeedPostsStream(e),
        indexObjectsSensedByDistance(isInactive),
        frp.hub()
    );
    const speedPostIndex = frp.stepper(speedPostIndex$, new Map<number, Sensed<SpeedPost>>());

    const signalIndex$ = frp.compose(
        e.createPlayerWithKeyUpdateStream(),
        mapSignalStream(e),
        indexObjectsSensedByDistance(isInactive)
    );
    const signalIndex = frp.stepper(signalIndex$, new Map<number, Sensed<Signal>>());

    const trackSpeedMps$ = frp.compose(
        speedPostIndex$,
        createTrackSpeedStream(
            () => e.rv.GetCurrentSpeedLimit()[0],
            () => e.rv.GetConsistLength(),
            isInactive
        ),
        frp.hub()
    );
    const isDegraded$ = frp.compose(
        trackSpeedMps$,
        frp.map(speedMps => speedMps < 16 * c.mph.toMps)
    );
    const isDegraded = frp.stepper(isDegraded$, false);

    const sortedHazards$ = frp.compose(
        trackSpeedMps$,
        frp.fold<HazardsAccum, number>(
            (accum, trackSpeedMps) => {
                const theSpeedMps = frp.snapshot(speedMps);
                const thePts = frp.snapshot(pts);

                let hazards: Hazard[] = [];
                // Add advance speed limits.
                let advanceLimits = new Map<number, AdvanceLimitHazard>();
                for (const [id, sensed] of frp.snapshot(speedPostIndex)) {
                    const hazard = accum.advanceLimits.get(id) || new AdvanceLimitHazard();
                    advanceLimits.set(id, hazard);
                    hazard.update(theSpeedMps, sensed);
                    hazards.push(hazard);
                }
                // Add stop signals, if we are not in degraded mode and a
                // positive stop is imminent.
                if (!frp.snapshot(isDegraded) && typeof thePts === "number") {
                    for (const [id, [distanceM, signal]] of frp.snapshot(signalIndex)) {
                        if (signal.proState === rw.ProSignalState.Red) {
                            const cushionM = 40 + c.ft.toM;
                            const hazard = new StopSignalHazard(theSpeedMps, thePts + cushionM, distanceM);
                            hazards.push(hazard);
                        }
                    }
                }
                // Add current track speed limit.
                hazards.push(new TrackSpeedHazard(frp.snapshot(trackSpeedMps)));
                // Sort by penalty curve speed.
                hazards.sort((a, b) => a.penaltyCurveMps - b.penaltyCurveMps);
                return { advanceLimits, hazards };
            },
            { advanceLimits: new Map(), hazards: [] }
        ),
        frp.map(accum => accum.hazards),
        frp.hub()
    );
    const sortedHazards = frp.stepper(sortedHazards$, []);

    const trackSpeedDowngrade$ = frp.compose(
        sortedHazards$,
        frp.map(h => {
            const lowestTrackSpeed = h.reduce((previous, current) =>
                previous.trackSpeedMps !== undefined ? previous : current
            );
            return lowestTrackSpeed.trackSpeedMps as number;
        }),
        fsm(0),
        frp.filter(([from, to]) => to < from),
        frp.map((_): AcsesEvent => AcsesEventType.Downgrade)
    );

    const accumStart: AcsesAccum = {
        acknowledged: new Set<Hazard>(),
        mode: AcsesModeType.Normal,
        inForce: new TrackSpeedHazard(hugeSpeed),
        trackSpeed: AcsesSpeed.CutOut,
    };
    return frp.compose(
        e.createPlayerWithKeyUpdateStream(),
        frp.map((pu): AcsesEvent => [AcsesEventType.Update, pu.dt]),
        frp.merge(trackSpeedDowngrade$),
        frp.fold<AcsesAccum, AcsesEvent>((accum, event) => {
            if (!frp.snapshot(isActive)) {
                return accumStart;
            }

            const theAck = frp.snapshot(acknowledge);
            const hazards = frp.snapshot(sortedHazards);

            // Track the use of the acknowledgement joystick for each
            // hazard. This information is used only when moving into the
            // alert or penalty states from the normal state.
            let acknowledged = new Set<Hazard>();
            for (const hazard of hazards) {
                if (accum.acknowledged.has(hazard)) {
                    acknowledged.add(hazard);
                }
            }
            const inForce = hazards[0];
            if (theAck && accum.mode !== AcsesModeType.Normal) {
                acknowledged.add(inForce);
            }

            const lowestTrackSpeed = hazards.reduce((previous, current) =>
                previous.trackSpeedMps !== undefined ? previous : current
            );
            const aSpeedMps = Math.abs(frp.snapshot(speedMps));

            let mode: AcsesMode;
            while (true) {
                // Normal state
                if (accum.mode === AcsesModeType.Normal) {
                    const initAck = acknowledged.has(inForce);
                    if (aSpeedMps > inForce.penaltyCurveMps) {
                        mode = [AcsesModeType.Penalty, initAck];
                    } else if (aSpeedMps > inForce.alertCurveMps) {
                        mode = [AcsesModeType.Alert, 0, initAck];
                    } else if (event === AcsesEventType.Downgrade) {
                        mode = [AcsesModeType.Alert, 0, false];
                    } else {
                        mode = AcsesModeType.Normal;
                    }
                    break;
                }

                // Alert state
                const [m] = accum.mode;
                if (m === AcsesModeType.Alert) {
                    const [, stopwatchS, aAck] = accum.mode;
                    if (aSpeedMps < inForce.alertCurveMps && aAck) {
                        mode = AcsesModeType.Normal;
                    } else if (stopwatchS > alertCountdownS) {
                        mode = [AcsesModeType.Penalty, aAck];
                    } else if (event === AcsesEventType.Downgrade) {
                        mode = accum.mode;
                    } else {
                        const [, dt] = event;
                        mode = [AcsesModeType.Alert, stopwatchS + dt, aAck || theAck];
                    }
                    break;
                }

                // Penalty state
                {
                    const [, aAck] = accum.mode;
                    if (aSpeedMps < inForce.alertCurveMps - alertMarginMps && aAck && frp.snapshot(coastOrBrake)) {
                        mode = AcsesModeType.Normal;
                    } else {
                        mode = [AcsesModeType.Penalty, aAck || theAck];
                    }
                    break;
                }
            }

            return {
                acknowledged,
                mode,
                inForce,
                trackSpeed: frp.snapshot(isDegraded)
                    ? AcsesSpeed.Degraded
                    : [AcsesSpeed.Enforcing, lowestTrackSpeed.trackSpeedMps as number],
            };
        }, accumStart),
        frp.map(accum => {
            const aSpeedMps = Math.abs(frp.snapshot(speedMps));

            let brakes, alarm;
            if (accum.mode === AcsesModeType.Normal) {
                brakes = AcsesBrake.None;
                alarm = false;
            } else {
                const [mode] = accum.mode;
                if (mode === AcsesModeType.Alert) {
                    brakes = AcsesBrake.None;
                    alarm = true;
                } else if (accum.inForce instanceof StopSignalHazard && accum.inForce.alertCurveMps < 1) {
                    const [, ack] = accum.mode;
                    brakes = AcsesBrake.PositiveStop;
                    alarm = !(aSpeedMps < c.stopSpeed && ack);
                } else {
                    brakes = AcsesBrake.Penalty;
                    alarm = true;
                }
            }
            return {
                brakes,
                alarm,
                overspeed: aSpeedMps > accum.inForce.alertCurveMps && accum.inForce.alertCurveMps > 1,
                trackSpeed: accum.trackSpeed,
            };
        })
    );
}

/**
 * Create a continuous stream of searches for speed limit changes.
 * @param e The rail vehicle to sense objects with.
 * @returns The new event stream of speed post readings.
 */
function mapSpeedPostsStream(e: FrpEngine): (eventStream: frp.Stream<PlayerUpdate>) => frp.Stream<Reading<SpeedPost>> {
    const nLimits = 3;
    return eventStream => {
        return frp.compose(
            eventStream,
            frp.map(pu => {
                const speedMpS = e.rv.GetSpeed(); // Must be as precise as possible.
                const traveledM = speedMpS * pu.dt;
                let posts: Sensed<SpeedPost>[] = [];
                for (const [distanceM, post] of iterateSpeedLimitsBackward(e, nLimits)) {
                    if (post.speedMps < hugeSpeed) {
                        posts.push([-distanceM, post]);
                    }
                }
                for (const [distanceM, post] of iterateSpeedLimitsForward(e, nLimits)) {
                    if (post.speedMps < hugeSpeed) {
                        posts.push([distanceM, post]);
                    }
                }
                return [traveledM, posts];
            })
        );
    };
}

function iterateSpeedLimitsForward(e: FrpEngine, nLimits: number): Sensed<SpeedPost>[] {
    return iterateSpeedLimits(rw.ConsistDirection.Forward, e, nLimits, 0);
}

function iterateSpeedLimitsBackward(e: FrpEngine, nLimits: number): Sensed<SpeedPost>[] {
    return iterateSpeedLimits(rw.ConsistDirection.Backward, e, nLimits, 0);
}

function iterateSpeedLimits(
    dir: rw.ConsistDirection,
    e: FrpEngine,
    nLimits: number,
    minDistanceM: number
): Sensed<SpeedPost>[] {
    if (nLimits <= 0) {
        return [];
    } else {
        const nextLimit = e.rv.GetNextSpeedLimit(dir, minDistanceM);
        if (typeof nextLimit === "number") {
            // Search failed, and further searching would be futile.
            return [];
        } else {
            const [type, speedMps, distanceM] = nextLimit;
            const result: Sensed<SpeedPost>[] = [[distanceM, { type: type, speedMps: speedMps }]];
            result.push(...iterateSpeedLimits(dir, e, nLimits - 1, distanceM + iterateStepM));
            return result;
        }
    }
}

/**
 * Create a continuous stream of searches for restrictive signals.
 * @param e The rail vehicle to sense objects with.
 * @returns The new event stream of signal readings.
 */
function mapSignalStream(e: FrpEngine): (eventStream: frp.Stream<PlayerUpdate>) => frp.Stream<Reading<Signal>> {
    const nSignals = 3;
    return eventStream => {
        return frp.compose(
            eventStream,
            frp.map(pu => {
                const speedMpS = e.rv.GetSpeed(); // Must be as precise as possible.
                const traveledM = speedMpS * pu.dt;
                let signals: Sensed<Signal>[] = [];
                for (const [distanceM, signal] of iterateSignalsBackward(e, nSignals)) {
                    signals.push([-distanceM, signal]);
                }
                signals.push(...iterateSignalsForward(e, nSignals));
                return [traveledM, signals];
            })
        );
    };
}

function iterateSignalsForward(e: FrpEngine, nSignals: number): Sensed<Signal>[] {
    return iterateRestrictiveSignals(rw.ConsistDirection.Forward, e, nSignals, 0);
}

function iterateSignalsBackward(e: FrpEngine, nSignals: number): Sensed<Signal>[] {
    return iterateRestrictiveSignals(rw.ConsistDirection.Backward, e, nSignals, 0);
}

function iterateRestrictiveSignals(
    dir: rw.ConsistDirection,
    e: FrpEngine,
    nSignals: number,
    minDistanceM: number
): Sensed<Signal>[] {
    if (nSignals <= 0) {
        return [];
    } else {
        const nextSignal = e.rv.GetNextRestrictiveSignal(dir, minDistanceM);
        if (typeof nextSignal === "number") {
            // Search failed, and further searching would be futile.
            return [];
        } else {
            const [, distanceM, proState] = nextSignal;
            const result: Sensed<Signal>[] = [[distanceM, { proState: proState }]];
            result.push(...iterateRestrictiveSignals(dir, e, nSignals - 1, distanceM + iterateStepM));
            return result;
        }
    }
}

/**
 * Create a continuous event stream that tracks the current track speed limit as
 * sensed by the head-end unit.
 * @param gameTrackSpeedLimitMps A behavior to obtain the game-provided track
 * speed limit, which changes when the rear of the train clears the last
 * restriction.
 * @param consistLengthM A behavior to obtain the length of the player's
 * consist.
 * @param reset A behavior that can be used to reset this tracker.
 * @returns The new event stream of track speed in m/s.
 */
function createTrackSpeedStream(
    gameTrackSpeedLimitMps: frp.Behavior<number>,
    consistLengthM: frp.Behavior<number>,
    reset: frp.Behavior<boolean>
): (eventStream: frp.Stream<Map<number, Sensed<SpeedPost>>>) => frp.Stream<number> {
    return indexStream => {
        const twoSidedPosts = frp.stepper(trackSpeedPostSpeeds(indexStream), new Map<number, TwoSidedSpeedPost>());
        return frp.compose(
            indexStream,
            frp.fold<number, Map<number, Sensed<SpeedPost>>>(
                (accum, index) => {
                    if (frp.snapshot(reset)) {
                        return 0;
                    }

                    // Locate the adjacent speed posts.
                    const justBefore = bestScoreOfMapEntries(index, (_, [distanceM]) =>
                        distanceM < 0 ? distanceM : undefined
                    );
                    const justAfter = bestScoreOfMapEntries(index, (_, [distanceM]) =>
                        distanceM > 0 ? -distanceM : undefined
                    );

                    // If we're on the other side of a recorded speed post, we can infer
                    // the current speed limit.
                    let inferredSpeedMps: number | undefined = undefined;
                    if (justBefore !== undefined) {
                        const twoPost = frp.snapshot(twoSidedPosts).get(justBefore) as TwoSidedSpeedPost;
                        inferredSpeedMps = twoPost.after?.speedMps;
                    }
                    if (inferredSpeedMps === undefined && justAfter !== undefined) {
                        const twoPost = frp.snapshot(twoSidedPosts).get(justAfter) as TwoSidedSpeedPost;
                        inferredSpeedMps = twoPost.before?.speedMps;
                    }
                    // If inference fails, stick with the previous speed...
                    if (inferredSpeedMps === undefined) {
                        inferredSpeedMps = accum;
                    }

                    const gameSpeedMps = frp.snapshot(gameTrackSpeedLimitMps);
                    if (gameSpeedMps > inferredSpeedMps) {
                        // The game speed limit is strictly lower than the track speed
                        // limit we're after, so if that is higher, then we should use it.
                        return gameSpeedMps;
                    } else if (justBefore !== undefined) {
                        // If the previous speed post is behind the end of our train, then
                        // we can also use the game speed limit.
                        const [justBeforeDistanceM] = index.get(justBefore) as Sensed<SpeedPost>;
                        if (-justBeforeDistanceM > frp.snapshot(consistLengthM)) {
                            return gameSpeedMps;
                        }
                    }
                    return inferredSpeedMps;
                },
                0 // Should get instantly replaced by the game-calculated speed.
            )
        );
    };
}

/**
 * Save both "ends" of speed posts as seen by the rail vehicle as it overtakes
 * them.
 */
const trackSpeedPostSpeeds = frp.fold<Map<number, TwoSidedSpeedPost>, Map<number, Sensed<SpeedPost>>>(
    (accum, index) => {
        let newAccum = new Map<number, TwoSidedSpeedPost>();
        for (const [id, [distanceM, post]] of index) {
            const sides = accum.get(id);
            let newSides: TwoSidedSpeedPost;
            if (sides !== undefined) {
                if (distanceM < 0) {
                    newSides = { before: post, after: sides.after };
                } else if (distanceM > 0) {
                    newSides = { before: sides.before, after: post };
                } else {
                    newSides = sides;
                }
            } else {
                newSides = distanceM >= 0 ? { before: undefined, after: post } : { before: post, after: undefined };
            }
            newAccum.set(id, newSides);
        }
        return newAccum;
    },
    new Map()
);

/**
 * Tags objects that can only be sensed by distance statelessly with
 * persistent ID's.
 *
 * Track objects will briefly disappear before they reappear in the reverse
 * direction - the exact distance is possibly the locomotive length? We call
 * this area the "passing" zone.
 *
 * d < 0|invisible|d > 0
 * ---->|_________|<----
 *
 * @param reset A behavior that can be used to reset this tracker.
 * @returns An stream of mappings from unique identifier to sensed object.
 */
function indexObjectsSensedByDistance<T>(
    reset: frp.Behavior<boolean>
): (eventStream: frp.Stream<Reading<T>>) => frp.Stream<Map<number, Sensed<T>>> {
    const maxPassingM = 28.5; // 1.1*85 ft
    const senseMarginM = 4;
    return eventStream => {
        const accumStart: ObjectIndexAccum<T> = {
            counter: -1,
            sensed: new Map(),
            passing: new Map(),
        };
        return frp.compose(
            eventStream,
            frp.fold<ObjectIndexAccum<T>, Reading<T>>((accum, reading) => {
                if (frp.snapshot(reset)) {
                    return accumStart;
                }

                const [traveledM, objects] = reading;
                let counter = accum.counter;
                let sensed = new Map<number, Sensed<T>>();
                let passing = new Map<number, Sensed<T>>();
                for (const [distanceM, obj] of objects) {
                    // There's no continue in Lua 5.0, but we do have break...
                    while (true) {
                        // First, try to match a sensed object with a previously sensed
                        // object.
                        const bestSensed = bestScoreOfMapEntries(accum.sensed, (id, [sensedDistanceM]) => {
                            if (sensed.has(id)) {
                                return undefined;
                            } else {
                                const inferredM = sensedDistanceM - traveledM;
                                const differenceM = Math.abs(inferredM - distanceM);
                                return differenceM > senseMarginM ? undefined : -differenceM;
                            }
                        });
                        if (bestSensed !== undefined) {
                            sensed.set(bestSensed, [distanceM, obj]);
                            break;
                        }

                        // Next, try to match with a passing object.
                        let bestPassing: number | undefined;
                        if (distanceM <= 0 && distanceM > -senseMarginM) {
                            bestPassing = bestScoreOfMapEntries(accum.passing, (id, [passingDistanceM]) => {
                                const inferredM = passingDistanceM - traveledM;
                                return sensed.has(id) ? undefined : -inferredM;
                            });
                        } else if (distanceM >= 0 && distanceM < senseMarginM) {
                            bestPassing = bestScoreOfMapEntries(accum.passing, (id, [passingDistanceM]) => {
                                const inferredM = passingDistanceM - traveledM;
                                return sensed.has(id) ? undefined : inferredM;
                            });
                        }
                        if (bestPassing !== undefined) {
                            sensed.set(bestPassing, [distanceM, obj]);
                            break;
                        }

                        // If neither strategy matched, then this is a new object.
                        sensed.set(++counter, [distanceM, obj]);
                        break;
                    }
                }

                // Cull objects in the passing zone that have exceeded the
                // maximum passing distance.
                for (const [id, [distanceM, obj]] of accum.passing) {
                    if (!sensed.has(id)) {
                        const inferredM = distanceM - traveledM;
                        if (Math.abs(inferredM) <= maxPassingM) {
                            passing.set(id, [inferredM, obj]);
                            sensed.set(id, [inferredM, obj]);
                        }
                    }
                }

                // Add back objects that haven't been matched to anything
                // else and are in the passing zone.
                for (const [id, [distanceM, obj]] of accum.sensed) {
                    if (!sensed.has(id) && !passing.has(id)) {
                        const inferredM = distanceM - traveledM;
                        if (Math.abs(inferredM) <= maxPassingM) {
                            passing.set(id, [inferredM, obj]);
                            sensed.set(id, [inferredM, obj]);
                        }
                    }
                }

                return { counter: counter, sensed: sensed, passing: passing };
            }, accumStart),
            frp.map(accum => accum.sensed)
        );
    };
}

/**
 * Score the entries of a map and return the best-scoring one.
 * @param map The map to search.
 * @param score A function that scores an entry in a map. It may also return
 * undefined, in which case this entry will be excluded.
 * @returns The highest-scoring key, if any.
 */
function bestScoreOfMapEntries<K, V>(map: Map<K, V>, score: (key: K, value: V) => number | undefined): K | undefined {
    let best: K | undefined = undefined;
    let bestScore: number | undefined = undefined;
    for (const [k, v] of map) {
        const s = score(k, v);
        if (s !== undefined && (bestScore === undefined || s > bestScore)) {
            best = k;
            bestScore = s;
        }
    }
    return best;
}

/**
 * Describes any piece of the ACSES braking curve.
 */
interface Hazard {
    /**
     * The current alert curve speed.
     */
    alertCurveMps: number;
    /**
     * The current penalty curve speed.
     */
    penaltyCurveMps: number;
    /**
     * The track speed to display when this hazard is in force, if any.
     */
    trackSpeedMps?: number;
}

/**
 * A stateless hazard that represents the current track speed limit.
 */
class TrackSpeedHazard implements Hazard {
    alertCurveMps: number;
    penaltyCurveMps: number;
    trackSpeedMps: number;

    constructor(speedMps: number) {
        this.alertCurveMps = speedMps + alertMarginMps;
        this.penaltyCurveMps = speedMps + penaltyMarginMps;
        this.trackSpeedMps = speedMps;
    }
}

/**
 * An advance speed limit tracks the distance at which it is violated, and
 * reveals itself to the engineer.
 */
class AdvanceLimitHazard implements Hazard {
    alertCurveMps: number = hugeSpeed;
    penaltyCurveMps: number = hugeSpeed;
    trackSpeedMps?: number = undefined;

    private violatedAtM: number | undefined = undefined;

    update(playerSpeedMps: number, sensed: Sensed<SpeedPost>) {
        const [distanceM, post] = sensed;
        const aDistanceM = Math.abs(distanceM);

        // Reveal this limit if the advance braking curve has been violated.
        let revealTrackSpeed;
        if (this.violatedAtM !== undefined) {
            if (distanceM > 0 && playerSpeedMps > 0) {
                revealTrackSpeed = distanceM > 0 && distanceM < this.violatedAtM;
            } else if (distanceM < 0 && playerSpeedMps < 0) {
                revealTrackSpeed = distanceM < 0 && distanceM > this.violatedAtM;
            } else {
                revealTrackSpeed = false;
            }
        } else {
            revealTrackSpeed = false;
        }

        const rightWay = (distanceM > 0 && playerSpeedMps >= 0) || (distanceM < 0 && playerSpeedMps <= 0);
        this.alertCurveMps = rightWay
            ? Math.max(getBrakingCurve(post.speedMps, aDistanceM, alertCountdownS), post.speedMps + alertMarginMps)
            : hugeSpeed;
        this.penaltyCurveMps = rightWay
            ? Math.max(getBrakingCurve(post.speedMps, aDistanceM, 0), post.speedMps + penaltyMarginMps)
            : hugeSpeed;
        this.trackSpeedMps = revealTrackSpeed ? post.speedMps : undefined;
        if (this.violatedAtM === undefined && Math.abs(playerSpeedMps) > this.alertCurveMps) {
            this.violatedAtM = distanceM;
        }
    }
}

/**
 * A stateless hazard that represents a signal at Danger.
 */
class StopSignalHazard implements Hazard {
    alertCurveMps: number;
    penaltyCurveMps: number;
    trackSpeedMps = undefined;

    constructor(playerSpeedMps: number, targetM: number, distanceM: number) {
        const rightWay = (distanceM > 0 && playerSpeedMps >= 0) || (distanceM < 0 && playerSpeedMps <= 0);
        if (rightWay) {
            const curveDistanceM = Math.max(Math.abs(distanceM) - targetM, 0);
            this.alertCurveMps = getBrakingCurve(0, curveDistanceM, alertCountdownS);
            this.penaltyCurveMps = getBrakingCurve(0, curveDistanceM, 0);
        } else {
            this.alertCurveMps = hugeSpeed;
            this.penaltyCurveMps = hugeSpeed;
        }
    }
}

function getBrakingCurve(vf: number, d: number, t: number) {
    const a = penaltyCurveMps2;
    return Math.max(Math.pow(Math.pow(a * t, 2) - 2 * a * d + Math.pow(vf, 2), 0.5) + a * t, vf);
}
