/** @noSelfInFile */
/**
 * Advanced Civil Speed Enforcement System for the Long Island Rail Road.
 */

import * as cs from "./cabsignals";
import * as c from "./constants";
import * as frp from "./frp";
import { FrpEngine } from "./frp-engine";
import { debug, foldWithResetBehavior, fsm, rejectUndefined } from "./frp-extra";
import * as rw from "./railworks";

export type AcsesState = { brakes: AcsesBrake; overspeed: boolean; trackSpeedMps: number | undefined };
export enum AcsesBrake {
    None,
    Penalty,
    PositiveStop,
}

type AcsesMode =
    | AcsesModeType.Normal
    | [mode: AcsesModeType.Alert, countdownS: number]
    | AcsesModeType.Penalty
    | AcsesModeType.PenaltyAcknowledged;
type AcsesAccum = {
    advanceLimits: Map<number, AdvanceLimitHazard>;
    mode: AcsesMode;
    positiveStop: boolean;
    overspeed: boolean;
    trackSpeedMps: number | undefined;
};
enum AcsesModeType {
    Normal,
    Alert,
    Penalty,
    PenaltyAcknowledged,
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

const alertMarginMps = 3 * c.mph.toMps,
    penaltyMarginMps = 6 * c.mph.toMps,
    alertCountdownS = 6,
    penaltyCurveMps2 = -2 * c.mph.toMps,
    iterateStepM = 0.01,
    hugeSpeed = 999;

/**
 * Create a new ACSES instance.
 * @param e The player's engine.
 * @param acknowledge A behavior that indicates the state of the acknowledge
 * joystick.
 * @param coastOrBrake A behavior that indicates the master controller has been
 * placed into a braking or the coast position.
 * @param cutIn An event stream that indicates the state of the cut in control.
 * @param hasPower A behavior that indicates the unit is powered and keyed in.
 * @returns An event stream that commmunicates all state for this system.
 */
export function create(
    e: FrpEngine,
    acknowledge: frp.Behavior<boolean>,
    coastOrBrake: frp.Behavior<boolean>,
    cutIn: frp.Stream<boolean>,
    hasPower: frp.Behavior<boolean>
): frp.Stream<AcsesState> {
    const isPlayerEngine = () => e.eng.GetIsEngineWithKey(),
        cutInOut$ = frp.compose(
            cutIn,
            fsm<boolean>(false),
            frp.filter(([from, to]) => from !== to && frp.snapshot(isPlayerEngine))
        );
    cutInOut$(([, to]) => {
        const msg = to ? "Enabled" : "Disabled";
        rw.ScenarioManager.ShowMessage("ACSES Track Speed Enforcement", msg, rw.MessageBox.Alert);
    });

    const isCutOut = frp.liftN(
            (cutIn, hasPower, isPlayerEngine) => !(cutIn && hasPower && isPlayerEngine),
            frp.stepper(cutIn, false),
            hasPower,
            isPlayerEngine
        ),
        pts$ = frp.compose(
            e.createOnCustomSignalMessageStream(),
            frp.map((msg: string) => cs.toPositiveStopDistanceM(msg)),
            rejectUndefined<number | false>()
        ),
        pts = frp.stepper(pts$, false),
        speedMps = () => (e.rv.GetControlValue("SpeedometerMPH", 0) as number) * c.mph.toMps,
        speedPostIndex$ = frp.compose(
            e.createUpdateStream(),
            frp.reject(_ => frp.snapshot(isCutOut)),
            createSpeedPostsStream(e),
            indexObjectsSensedByDistance<SpeedPost>(isCutOut),
            frp.hub()
        ),
        speedPostIndex = frp.stepper(speedPostIndex$, new Map<number, Sensed<SpeedPost>>()),
        signalIndex$ = frp.compose(
            e.createUpdateStream(),
            frp.reject(_ => frp.snapshot(isCutOut)),
            createSignalStream(e),
            indexObjectsSensedByDistance<Signal>(isCutOut)
        ),
        signalIndex = frp.stepper(signalIndex$, new Map<number, Sensed<Signal>>()),
        trackSpeedMps$ = createTrackSpeedStream(
            () => e.rv.GetCurrentSpeedLimit()[0],
            () => e.rv.GetConsistLength(),
            isCutOut
        )(speedPostIndex$),
        trackSpeedMps = frp.stepper(trackSpeedMps$, hugeSpeed);
    return frp.compose(
        e.createUpdateStream(),
        foldWithResetBehavior<AcsesAccum, number>(
            (accum, t) => {
                const theSpeedMps = frp.snapshot(speedMps),
                    thePts = frp.snapshot(pts);
                let hazards: Hazard[] = [];

                // Add advance speed limits.
                let advanceLimits = new Map<number, AdvanceLimitHazard>();
                for (const [id, sensed] of frp.snapshot(speedPostIndex)) {
                    const hazard = accum.advanceLimits.get(id) || new AdvanceLimitHazard();
                    hazard.update(theSpeedMps, sensed);
                    advanceLimits.set(id, hazard);
                    hazards.push(hazard);
                }

                // Add stop signals, if in positive stop mode.
                for (const [id, [distanceM, signal]] of frp.snapshot(signalIndex)) {
                    if (typeof thePts === "number" && signal.proState === rw.ProSignalState.Red) {
                        hazards.push(new StopSignalHazard(theSpeedMps, thePts * c.ft.toM, distanceM));
                    }
                }

                // Add current track speed limit.
                hazards.push(new TrackSpeedHazard(frp.snapshot(trackSpeedMps)));

                // Sort by penalty curve speed.
                hazards.sort((a, b) => a.penaltyCurveMps - b.penaltyCurveMps);

                const aSpeedMps = Math.abs(theSpeedMps),
                    inForce = hazards[0],
                    lowestTrackSpeedMps = hazards.reduce((previous, current) =>
                        previous.trackSpeedMps !== undefined ? previous : current
                    ).trackSpeedMps as number,
                    isPositiveStop = inForce instanceof StopSignalHazard,
                    isOverspeed = aSpeedMps > inForce.alertCurveMps;
                let mode: AcsesMode;
                if (accum.mode === AcsesModeType.Penalty) {
                    mode = frp.snapshot(acknowledge) ? AcsesModeType.PenaltyAcknowledged : AcsesModeType.Penalty;
                } else if (
                    accum.mode === AcsesModeType.PenaltyAcknowledged &&
                    isPositiveStop &&
                    inForce.penaltyCurveMps < 1
                ) {
                    mode = AcsesModeType.PenaltyAcknowledged;
                } else if (accum.mode === AcsesModeType.PenaltyAcknowledged) {
                    mode =
                        !isOverspeed && frp.snapshot(coastOrBrake)
                            ? AcsesModeType.Normal
                            : AcsesModeType.PenaltyAcknowledged;
                } else if (accum.mode === AcsesModeType.Normal) {
                    mode = isOverspeed ? [AcsesModeType.Alert, t] : AcsesModeType.Normal;
                } else if (aSpeedMps > inForce.penaltyCurveMps) {
                    mode = AcsesModeType.Penalty;
                } else if (t - accum.mode[1] > alertCountdownS) {
                    mode = AcsesModeType.Penalty;
                } else if (!isOverspeed) {
                    mode = AcsesModeType.Normal;
                } else {
                    mode = accum.mode;
                }
                return {
                    advanceLimits: advanceLimits,
                    mode: mode,
                    positiveStop: isPositiveStop,
                    overspeed: isOverspeed,
                    trackSpeedMps: lowestTrackSpeedMps,
                };
            },
            {
                advanceLimits: new Map<number, AdvanceLimitHazard>(),
                mode: AcsesModeType.Normal,
                positiveStop: false,
                overspeed: false,
                trackSpeedMps: undefined,
            },
            isCutOut
        ),
        frp.map(accum => {
            let brakes;
            if (accum.mode === AcsesModeType.Penalty || accum.mode === AcsesModeType.PenaltyAcknowledged) {
                brakes = accum.positiveStop ? AcsesBrake.PositiveStop : AcsesBrake.Penalty;
            } else {
                brakes = AcsesBrake.None;
            }
            return {
                brakes: brakes,
                overspeed: accum.overspeed,
                trackSpeedMps: accum.trackSpeedMps,
            };
        })
    );
}

/**
 * Create a continuous stream of searches for speed limit changes.
 * @param e The rail vehicle to sense objects with.
 * @returns The new event stream of speed post readings.
 */
function createSpeedPostsStream(e: FrpEngine): (eventStream: frp.Stream<any>) => frp.Stream<Reading<SpeedPost>> {
    const nLimits = 3;
    return eventStream => {
        return frp.compose(
            eventStream,
            fsm<number>(0),
            frp.map(([from, to]) => {
                const speedMpS = e.rv.GetSpeed(), // Must be as precise as possible.
                    traveledM = speedMpS * (to - from);
                let posts: Sensed<SpeedPost>[] = [];
                for (const [distanceM, post] of iterateSpeedLimitsBackward(e, nLimits)) {
                    posts.push([-distanceM, post]);
                }
                posts.push(...iterateSpeedLimitsForward(e, nLimits));
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
function createSignalStream(e: FrpEngine): (eventStream: frp.Stream<any>) => frp.Stream<Reading<Signal>> {
    const nSignals = 3;
    return eventStream => {
        return frp.compose(
            e.createUpdateStream(),
            fsm<number>(0),
            frp.map(([from, to]) => {
                const speedMpS = e.rv.GetSpeed(), // Must be as precise as possible.
                    traveledM = speedMpS * (to - from);
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
        return foldWithResetBehavior<number, Map<number, Sensed<SpeedPost>>>(
            (accum, index) => {
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
            hugeSpeed,
            reset
        )(indexStream);
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
    new Map<number, TwoSidedSpeedPost>()
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
    return eventStream =>
        frp.compose(
            eventStream,
            foldWithResetBehavior<
                { counter: number; sensed: Map<number, Sensed<T>>; passing: Map<number, Sensed<T>> },
                Reading<T>
            >(
                (accum, reading) => {
                    const [traveledM, objects] = reading;
                    let counter = accum.counter,
                        sensed = new Map<number, Sensed<T>>(),
                        passing = new Map<number, Sensed<T>>();
                    for (const [distanceM, obj] of objects) {
                        // There's no continue in Lua 5.0, but we do have break...
                        while (true) {
                            // First, try to match a sensed object with a previously sensed
                            // object.
                            const bestSensed = bestScoreOfMapEntries(accum.sensed, (id, [sensedDistanceM]) => {
                                if (sensed.has(id)) {
                                    return undefined;
                                } else {
                                    const inferredM = sensedDistanceM - traveledM,
                                        differenceM = Math.abs(inferredM - distanceM);
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
                },
                {
                    counter: -1,
                    sensed: new Map<number, Sensed<T>>(),
                    passing: new Map<number, Sensed<T>>(),
                },
                reset
            ),
            frp.map(accum => accum.sensed)
        );
}

/**
 * Score the entries of a map and return the best-scoring one.
 * @param map The map to search.
 * @param score A function that scores an entry in a map. It may also return
 * undefined, in which case this entry will be excluded.
 * @returns The highest-scoring key, if any.
 */
function bestScoreOfMapEntries<K, V>(map: Map<K, V>, score: (key: K, value: V) => number | undefined): K | undefined {
    let best: K | undefined = undefined,
        bestScore: number | undefined = undefined;
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
 * Describes any ACSES hazard with a continuous or advance braking curve.
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
        const [distanceM, post] = sensed,
            aDistanceM = Math.abs(distanceM);

        // Reveal this limit if the advance braking curve has been violated.
        let revealTrackSpeed: boolean;
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

        const rightWay = (distanceM > 0 && playerSpeedMps > 0) || (distanceM < 0 && playerSpeedMps < 0);
        if (!revealTrackSpeed) {
            // Ordinarily, use the (invisible) advance alert curve.
            this.alertCurveMps = rightWay
                ? Math.max(getBrakingCurve(post.speedMps, aDistanceM, alertCountdownS), post.speedMps + alertMarginMps)
                : hugeSpeed;
            this.trackSpeedMps = undefined;

            if (Math.abs(playerSpeedMps) > this.alertCurveMps) {
                this.violatedAtM = distanceM;
            }
        } else {
            // If this limit is revealed, use a flat alert curve that continuously warns the engineer.
            this.alertCurveMps = post.speedMps + alertMarginMps;
            this.trackSpeedMps = post.speedMps;
        }
        this.penaltyCurveMps = rightWay
            ? Math.max(getBrakingCurve(post.speedMps, aDistanceM, 0), post.speedMps + penaltyMarginMps)
            : hugeSpeed;
    }
}

/**
 * A stateless (for now) hazard that represents a signal at Danger.
 */
class StopSignalHazard implements Hazard {
    alertCurveMps: number;
    penaltyCurveMps: number;
    trackSpeedMps = undefined;

    constructor(playerSpeedMps: number, targetM: number, distanceM: number) {
        const rightWay = (distanceM > 0 && playerSpeedMps > 0) || (distanceM < 0 && playerSpeedMps < 0);
        if (rightWay) {
            const aDistanceM = Math.abs(distanceM);
            this.alertCurveMps = getBrakingCurve(0, aDistanceM - targetM, alertCountdownS);
            this.penaltyCurveMps = getBrakingCurve(0, aDistanceM - targetM, 0);
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
