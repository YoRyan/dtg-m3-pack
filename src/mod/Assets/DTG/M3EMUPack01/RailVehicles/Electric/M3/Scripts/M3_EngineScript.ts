/** @noSelfInFile */

import * as acses from "lib/acses";
import * as ale from "lib/alerter";
import * as asc from "lib/asc";
import * as cs from "lib/cabsignals";
import * as c from "lib/constants";
import * as frp from "lib/frp";
import { FrpEngine } from "lib/frp-engine";
import { fsm, mapBehavior, rejectUndefined } from "lib/frp-extra";
import { PlayerUpdate, SensedDirection, VehicleCamera } from "lib/frp-vehicle";
import * as m from "lib/math";
import * as rw from "lib/railworks";

enum ControlEvent {
    Autostart,
    Autostop,
    EmergencyBrake,
}

enum InterlockAllows {
    MasterKeyIn = 0,
    MasterKeyOutMasterControllerNonEmergency = 1,
    ReverserNonKeyOutMasterControllerEmergency = 2,
    ReverserKeyOut = 3,
}

type MasterController =
    | [ControllerRegion.Power, number]
    | ControllerRegion.Coast
    | [ControllerRegion.ServiceBrake, number]
    | ControllerRegion.EmergencyBrake;
enum ControllerRegion {
    Power,
    Coast,
    ServiceBrake,
    EmergencyBrake,
}

enum Reverser {
    KeyOut,
    Forward,
    Neutral,
    Reverse,
}

enum MasterKey {
    KeyIn,
    KeyOut,
}

type CssAccum = { current: undefined | cs.LirrAspect; next: undefined | [aspect: cs.LirrAspect, inS: number] };
type CssEvent = [event: CssEventType.Update, deltaS: number] | [event: CssEventType.Aspect, aspect: cs.LirrAspect];
enum CssEventType {
    Update,
    Aspect,
}

type BrakeCommand = BrakeType.None | [BrakeType.Service, number] | BrakeType.Emergency;
type BrakeEvent = BrakeType.Emergency | BrakeType.Autostart | [BrakeType.Charge, number];
enum BrakeType {
    None,
    Service,
    Emergency,
    Charge,
    Autostart,
}

type Overspeed =
    | OverspeedMode.None
    | [mode: OverspeedMode.Warning, timerS: number]
    | [mode: OverspeedMode.Penalty, timerS: number];
enum OverspeedMode {
    None,
    Warning,
    Penalty,
}

enum HeadLight {
    Off,
    Dim,
    Bright,
    BrightAi,
}

enum BrakeLight {
    Green,
    Amber,
    Dark,
}

type WiperUpdate = [setting: WiperMode, dt: number];
type WiperAccum = [mode: WiperMode, cycleS: number];
enum WiperMode {
    Int3,
    Int2,
    Int1,
    Off,
    Low,
    High,
}

const me = new FrpEngine(() => {
    // Useful streams and behaviors
    const speedoMph$ = frp.compose(me.createPlayerWithKeyUpdateStream(), me.mapGetCvStream("SpeedometerMPH", 0));
    const speedoMph = frp.stepper(speedoMph$, 0);
    const brakePipePsi$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        me.mapGetCvStream("AirBrakePipePressurePSI", 0)
    );
    const brakePipePsi = frp.stepper(brakePipePsi$, 0);

    // Event streams for the startup (Z) and emergency brake (Backspace)
    // controls
    const autostartEvent$ = frp.compose(
        me.createOnCvChangeStreamFor("VirtualStartup", 0),
        frp.filter(cv => cv >= 1 || cv <= -1),
        frp.map(cv => (cv > 0 ? ControlEvent.Autostart : ControlEvent.Autostop))
    );
    const emergencyPullCordEvent$ = frp.compose(
        me.createOnCvChangeStreamFor("VirtualEmergencyBrake", 0),
        frp.filter(cv => cv >= 1),
        frp.map(_ => ControlEvent.EmergencyBrake)
    );

    // The master controller/reverser/master key interlock
    const interlockState$ = frp.compose(
        me.createOnCvChangeStream(),
        frp.merge(autostartEvent$),
        me.foldAfterSettled(
            (accum, input) => {
                switch (input) {
                    case ControlEvent.Autostart:
                        return InterlockAllows.ReverserKeyOut;
                    case ControlEvent.Autostop:
                        return InterlockAllows.MasterKeyIn;
                    case ControlEvent.EmergencyBrake:
                        return accum;
                    default:
                }
                const [name, , value] = input;
                switch (accum) {
                    case InterlockAllows.MasterKeyIn:
                        if (name === "MasterKey" && value > 0.5) {
                            return InterlockAllows.MasterKeyOutMasterControllerNonEmergency;
                        }
                        break;
                    case InterlockAllows.MasterKeyOutMasterControllerNonEmergency:
                        if (name === "MasterKey" && value < 0.5) {
                            return InterlockAllows.MasterKeyIn;
                        } else if (name === "ThrottleAndBrake" && value > -0.95) {
                            return InterlockAllows.ReverserNonKeyOutMasterControllerEmergency;
                        }
                        break;
                    case InterlockAllows.ReverserNonKeyOutMasterControllerEmergency:
                        if (name === "UserVirtualReverser" && value < 2.5) {
                            return InterlockAllows.ReverserKeyOut;
                        } else if (name === "ThrottleAndBrake" && value < -0.95) {
                            return InterlockAllows.MasterKeyOutMasterControllerNonEmergency;
                        }
                        break;
                    case InterlockAllows.ReverserKeyOut:
                    default:
                        if (name === "UserVirtualReverser" && value > 2.5) {
                            return InterlockAllows.ReverserNonKeyOutMasterControllerEmergency;
                        }
                        break;
                }
                return accum;
            },
            () => me.rv.GetControlValue("Interlock", 0) as InterlockAllows
        ),
        frp.hub()
    );
    interlockState$(i => {
        me.rv.SetControlValue("Interlock", 0, i as number);
    });
    const interlockState = frp.stepper(interlockState$, undefined);

    // "Write back" values to interlocked controls so that they cannot be
    // manipulated by the player. We also process autostart events here.
    const rwMasterController$ = frp.compose(
        autostartEvent$,
        frp.map(evt => (evt === ControlEvent.Autostart ? -0.9 : -1)),
        frp.merge(me.createGetCvAndOnCvChangeStreamFor("ThrottleAndBrake", 0)),
        frp.map(cv => {
            switch (frp.snapshot(interlockState)) {
                case InterlockAllows.MasterKeyIn:
                    return -1;
                case InterlockAllows.MasterKeyOutMasterControllerNonEmergency:
                case InterlockAllows.ReverserNonKeyOutMasterControllerEmergency:
                    return cv;
                case InterlockAllows.ReverserKeyOut:
                    return Math.max(cv, -0.9);
                case undefined:
                    return undefined;
            }
        }),
        rejectUndefined(),
        frp.hub()
    );
    const rwReverser$ = frp.compose(
        autostartEvent$,
        frp.map(evt => (evt === ControlEvent.Autostart ? 1 : 3)),
        frp.merge(me.createGetCvAndOnCvChangeStreamFor("UserVirtualReverser", 0)),
        frp.map(cv => {
            switch (frp.snapshot(interlockState)) {
                case InterlockAllows.MasterKeyIn:
                case InterlockAllows.MasterKeyOutMasterControllerNonEmergency:
                    return 3;
                case InterlockAllows.ReverserNonKeyOutMasterControllerEmergency:
                case InterlockAllows.ReverserKeyOut:
                    return cv;
                case undefined:
                    return undefined;
            }
        }),
        rejectUndefined(),
        frp.hub()
    );
    const rwMasterKey$ = frp.compose(
        autostartEvent$,
        frp.map(evt => (evt === ControlEvent.Autostart ? 1 : 0)),
        frp.merge(me.createGetCvAndOnCvChangeStreamFor("MasterKey", 0)),
        frp.map(cv => {
            switch (frp.snapshot(interlockState)) {
                case InterlockAllows.MasterKeyIn:
                case InterlockAllows.MasterKeyOutMasterControllerNonEmergency:
                    return cv;
                case InterlockAllows.ReverserNonKeyOutMasterControllerEmergency:
                case InterlockAllows.ReverserKeyOut:
                    return 1;
                case undefined:
                    return undefined;
            }
        }),
        rejectUndefined(),
        frp.hub()
    );
    rwMasterController$(cv => {
        me.rv.SetControlValue("ThrottleAndBrake", 0, cv);
    });
    rwReverser$(cv => {
        me.rv.SetControlValue("UserVirtualReverser", 0, cv);
    });
    rwMasterKey$(cv => {
        me.rv.SetControlValue("MasterKey", 0, cv);
    });

    // Friendly event streams and behaviors for reading the positions of the
    // controls
    const masterController$ = frp.compose(
        rwMasterController$,
        frp.map((cv): MasterController => {
            if (cv < -0.9 - 0.05) {
                return ControllerRegion.EmergencyBrake;
            } else if (cv < -0.2 + 0.05) {
                // scaled from 0 (min braking) to 1 (max service braking)
                return [ControllerRegion.ServiceBrake, ((1 - 0) / (-0.9 + 0.2)) * (cv + 0.9) + 1];
            } else if (cv < 0.2 - 0.05) {
                return ControllerRegion.Coast;
            } else {
                // scaled from 0 (min power) to 1 (max power)
                return [ControllerRegion.Power, ((1 - 0) / (1 - 0.2)) * (cv - 1) + 1];
            }
        })
    );
    const masterController = frp.stepper(masterController$, undefined);
    const userReverser$ = frp.compose(
        rwReverser$,
        frp.map(cv => {
            if (cv < 0 + 0.5) {
                return Reverser.Reverse;
            } else if (cv < 1 + 0.5) {
                return Reverser.Neutral;
            } else if (cv < 2 + 0.5) {
                return Reverser.Forward;
            } else {
                return Reverser.KeyOut;
            }
        })
    );
    const masterKey$ = frp.compose(
        rwMasterKey$,
        frp.map(cv => (cv > 0.5 ? MasterKey.KeyIn : MasterKey.KeyOut))
    );
    const hasPower$ = frp.compose(
        masterKey$,
        frp.map(mk => mk === MasterKey.KeyIn),
        frp.hub()
    );
    const hasPower = frp.stepper(hasPower$, false);

    // Useful behaviors for setting up safety systems
    const acknowledge = () => (me.rv.GetControlValue("AWSReset", 0) as number) > 0.5;
    const coastOrBrake = () => {
        const mc = frp.snapshot(masterController);
        if (mc === undefined || mc === ControllerRegion.EmergencyBrake || mc === ControllerRegion.Coast) {
            return true;
        } else {
            const [region] = mc;
            return region === ControllerRegion.ServiceBrake;
        }
    };

    // Pulse code cab signaling
    const cabSignalResume$ = frp.compose(
        me.createOnResumeStream(),
        frp.map(_ => {
            const cv = me.rv.GetControlValue("LirrAspect", 0) as number;
            return cv as cs.LirrAspect;
        })
    );
    const cabSignal$ = frp.compose(
        me.createOnSignalMessageStream(),
        frp.map(msg => cs.toPulseCode(msg)),
        rejectUndefined(),
        frp.map(pc => cs.toLirrAspect(pc)),
        frp.merge(cabSignalResume$),
        frp.hub()
    );
    const cabSignalEvent$ = frp.compose(
        cabSignal$,
        frp.map((aspect): CssEvent => [CssEventType.Aspect, aspect])
    );
    const cabSignalWithDelay$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        frp.map((pu): CssEvent => [CssEventType.Update, pu.dt]),
        frp.merge(cabSignalEvent$),
        frp.fold<CssAccum, CssEvent>(
            (accum, event) => {
                const [e] = event;
                if (e === CssEventType.Aspect) {
                    const [, aspect] = event;
                    if (accum.current === undefined) {
                        return { current: aspect, next: undefined };
                    } else {
                        const isDowngrade =
                            (aspect as number) < (accum.current as number) && aspect !== cs.LirrAspect.Speed15;
                        const delayS = isDowngrade ? 1.8 : 3.2;
                        return { current: accum.current, next: [aspect, delayS] };
                    }
                } else if (accum.next === undefined) {
                    return accum;
                } else {
                    const [, dt] = event;
                    const [next, inS] = accum.next;
                    if (inS - dt <= 0) {
                        return { current: next, next: undefined };
                    } else {
                        return { current: accum.current, next: [next, inS - dt] };
                    }
                }
            },
            { current: undefined, next: undefined }
        ),
        frp.map(accum => accum.current),
        rejectUndefined()
    );
    const saveCabSignal$ = frp.compose(
        cabSignal$,
        frp.filter(() => frp.snapshot(me.areControlsSettled))
    );
    const setSignalSpeed$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        mapBehavior(
            frp.liftN(
                (aspect, hasPower) =>
                    hasPower && aspect !== undefined
                        ? {
                              [cs.LirrAspect.Speed15]: 15,
                              [cs.LirrAspect.Speed30]: 30,
                              [cs.LirrAspect.Speed40]: 40,
                              [cs.LirrAspect.Speed60]: 60,
                              [cs.LirrAspect.Speed70]: 70,
                              [cs.LirrAspect.Speed80]: 80,
                          }[aspect]
                        : 0,
                frp.stepper(cabSignalWithDelay$, undefined),
                hasPower
            )
        )
    );
    saveCabSignal$(aspect => {
        me.rv.SetControlValue("LirrAspect", 0, aspect as number);
    });
    setSignalSpeed$(cv => {
        me.rv.SetControlValue("SignalSpeedLimit", 0, cv);
    });

    // Alerter (ALE) vigilance subsystem
    const aleActivity = frp.liftN(
        (acknowledge, mc, horn) => {
            let maxBrakeOrEmergency;
            if (mc === undefined) {
                maxBrakeOrEmergency = false;
            } else if (mc === ControllerRegion.EmergencyBrake) {
                maxBrakeOrEmergency = true;
            } else if (mc === ControllerRegion.Coast) {
                maxBrakeOrEmergency = false;
            } else {
                const [region, amount] = mc;
                maxBrakeOrEmergency = region === ControllerRegion.ServiceBrake && amount >= 1;
            }
            return acknowledge || horn || maxBrakeOrEmergency;
        },
        acknowledge,
        masterController,
        () => (me.rv.GetControlValue("Horn", 0) as number) > 0.5
    );
    const aleInputCancelsPenalty$ = frp.compose(
        masterController$,
        fsm<MasterController>(ControllerRegion.Coast),
        frp.filter(([from, to]) => from !== to && (from === ControllerRegion.Coast || to === ControllerRegion.Coast)),
        frp.map(_ => ale.AlerterInput.ActivityThatCancelsPenalty)
    );
    const aleInput$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        mapBehavior(aleActivity),
        frp.filter(v => v),
        frp.map(_ => ale.AlerterInput.Activity),
        frp.merge(aleInputCancelsPenalty$)
    );
    const aleCutIn = createCutInBehavior(me, "ALECutIn", 0);
    const ale$ = frp.compose(ale.create(me, aleInput$, aleCutIn, hasPower), frp.hub());
    const aleState = frp.stepper(ale$, undefined);
    ale$(state => {
        me.rv.SetControlValue("AlerterIndicator", 0, state.alarm ? 1 : 0);
        me.rv.SetControlValue("ALEAlarm", 0, state.alarm ? 1 : 0);
    });

    // ASC signal speed enforcement subsystem
    const ascCutIn = createCutInBehavior(me, "ATCCutIn", 0);
    const ascStatus$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        mapBehavior(
            frp.liftN(
                (cutIn, hasPower) => {
                    if (hasPower) {
                        return cutIn ? 1 : 0;
                    } else {
                        return -1;
                    }
                },
                ascCutIn,
                hasPower
            )
        )
    );
    const asc$ = frp.compose(
        asc.create(me, cabSignalWithDelay$, acknowledge, coastOrBrake, ascCutIn, hasPower),
        frp.hub()
    );
    const ascState = frp.stepper(asc$, undefined);
    ascStatus$(status => {
        me.rv.SetControlValue("ATCStatus", 0, status);
    });
    asc$(state => {
        me.rv.SetControlValue("Overspeed", 0, state.overspeed ? 1 : 0);
        me.rv.SetControlValue("ATCAlarm", 0, state.alarm ? 1 : 0);
        me.rv.SetControlValue("BrakeAssurance", 0, state.brakeAssurance ? 1 : 0);
        me.rv.SetControlValue("ATCForestall", 0, state.atcForestall ? 1 : 0);
    });

    // ACSES track speed enforcement subsystem
    const acsesCutIn = createCutInBehavior(me, "ACSESCutIn", 0);
    const acses$ = frp.compose(acses.create(me, acknowledge, coastOrBrake, acsesCutIn, hasPower), frp.hub());
    const acsesState = frp.stepper(acses$, undefined);
    const acsesStatus$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        mapBehavior(
            frp.liftN(
                (cutIn, hasPower, state) => {
                    if (hasPower) {
                        if (cutIn) {
                            return state?.trackSpeed === acses.AcsesSpeed.Degraded ? 1 : 2;
                        } else {
                            return 0;
                        }
                    } else {
                        return -1;
                    }
                },
                acsesCutIn,
                hasPower,
                acsesState
            )
        )
    );
    const acsesBeep$ = frp.compose(
        acses$,
        fsm<undefined | acses.AcsesState>(undefined),
        frp.filter(([from, to]) => {
            if (from === undefined || to === undefined) {
                return false;
            } else if (to.alarm) {
                return false;
            } else if (from.trackSpeed === acses.AcsesSpeed.CutOut) {
                return to.trackSpeed !== acses.AcsesSpeed.CutOut;
            } else if (from.trackSpeed === acses.AcsesSpeed.Degraded) {
                return to.trackSpeed !== acses.AcsesSpeed.CutOut && to.trackSpeed !== acses.AcsesSpeed.Degraded;
            } else {
                if (to.trackSpeed === acses.AcsesSpeed.CutOut) {
                    return false;
                } else if (to.trackSpeed === acses.AcsesSpeed.Degraded) {
                    return true;
                } else {
                    const [, fromMps] = from.trackSpeed;
                    const [, toMps] = to.trackSpeed;
                    return fromMps !== toMps;
                }
            }
        }),
        me.mapEventStreamTimer(),
        frp.map(onOff => (onOff ? 1 : 0))
    );
    const acsesOverspeed$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        frp.fold<Overspeed, PlayerUpdate>((accum, pu) => {
            const state = frp.snapshot(acsesState);
            let mode;
            if (state?.overspeed) {
                mode = state.brakes === acses.AcsesBrake.None ? OverspeedMode.Warning : OverspeedMode.Penalty;
            } else {
                mode = OverspeedMode.None;
            }

            if (mode === OverspeedMode.None) {
                return OverspeedMode.None;
            } else if (accum === OverspeedMode.None) {
                return [mode, 0];
            } else {
                const [, timerS] = accum;
                return [mode, timerS + pu.dt];
            }
        }, OverspeedMode.None)
    );
    acses$(state => {
        me.rv.SetControlValue("ACSESPenalty", 0, state.brakes !== acses.AcsesBrake.None ? 1 : 0);
        me.rv.SetControlValue("ACSESAlarm", 0, state.alarm ? 1 : 0);
        me.rv.SetControlValue("ACSESStop", 0, state.brakes === acses.AcsesBrake.PositiveStop ? 1 : 0);

        let h, t, u, d;
        if (state.trackSpeed === acses.AcsesSpeed.CutOut) {
            [h, t, u, d] = [-1, -1, -1, 0];
        } else if (state.trackSpeed === acses.AcsesSpeed.Degraded) {
            [h, t, u, d] = [-1, -1, -1, 1];
        } else {
            const [, speedMps] = state.trackSpeed;
            [[h, t, u]] = m.digits(Math.round(speedMps * c.mps.toMph), 3);
            d = 0;
        }
        me.rv.SetControlValue("TrackSpeedHundreds", 0, h);
        me.rv.SetControlValue("TrackSpeedTens", 0, t);
        me.rv.SetControlValue("TrackSpeedUnits", 0, u);
        me.rv.SetControlValue("TrackSpeedDashes", 0, d);
    });
    acsesStatus$(status => {
        me.rv.SetControlValue("ACSESStatus", 0, status);
    });
    acsesBeep$(cv => {
        me.rv.SetControlValue("ACSESBeep", 0, cv);
    });
    acsesOverspeed$(os => {
        let cv;
        if (os === OverspeedMode.None) {
            cv = 0;
        } else {
            const [mode, timerS] = os;
            if (timerS % 1 < 0.5) {
                cv = mode === OverspeedMode.Warning ? 1 : 2;
            } else {
                cv = 0;
            }
        }
        me.rv.SetControlValue("ACSESOverspeed", 0, cv);
    });

    // Set the common penalty brake indicator.
    const isAnyPenalty$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        mapBehavior(
            frp.liftN(
                (aleState, ascState, acsesState) => {
                    switch (aleState?.brakes) {
                        case ale.AlerterBrake.Penalty:
                            return true;
                        default:
                            break;
                    }
                    switch (ascState?.brakes) {
                        case asc.AscBrake.Penalty:
                        case asc.AscBrake.MaxService:
                            return true;
                        default:
                            break;
                    }
                    switch (acsesState?.brakes) {
                        case acses.AcsesBrake.Penalty:
                            return true;
                        default:
                            break;
                    }
                    return false;
                },
                aleState,
                ascState,
                acsesState
            )
        )
    );
    isAnyPenalty$(penalty => {
        me.rv.SetControlValue("PenaltyIndicator", 0, penalty ? 1 : 0);
    });

    // Show the exclamation symbol on the HUD for any audible alarm.
    const isAnyAlarm$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        mapBehavior(
            frp.liftN(
                (aleState, ascState, acsesState) => aleState?.alarm || ascState?.alarm || acsesState?.alarm,
                aleState,
                ascState,
                acsesState
            )
        )
    );
    isAnyAlarm$(alarm => {
        me.rv.SetControlValue("AWSWarnCount", 0, alarm ? 1 : 0);
    });

    // Logic for the virtual throttle, reverser, dynamic brake, and air brake
    const airBrakeChargeThreshold = 0.37; // 90 psi BP
    // The commanded brake setting depends on the position of the master
    // controller and the penalty applications issued by the safety systems.
    const brakeCommand = frp.liftN(
        (mc, aleState, ascState, acsesState): BrakeCommand => {
            if (ascState?.brakes === asc.AscBrake.Emergency || mc === ControllerRegion.EmergencyBrake) {
                return BrakeType.Emergency;
            } else if (
                aleState?.brakes === ale.AlerterBrake.Penalty ||
                ascState?.brakes === asc.AscBrake.Penalty ||
                ascState?.brakes === asc.AscBrake.MaxService ||
                acsesState?.brakes === acses.AcsesBrake.Penalty ||
                acsesState?.brakes === acses.AcsesBrake.PositiveStop
            ) {
                return [BrakeType.Service, 1];
            } else if (mc === undefined) {
                return BrakeType.None;
            } else if (mc === ControllerRegion.Coast) {
                return BrakeType.None;
            } else {
                const [region, amount] = mc;
                return region === ControllerRegion.ServiceBrake ? [BrakeType.Service, amount] : BrakeType.None;
            }
        },
        masterController,
        aleState,
        ascState,
        acsesState
    );
    // The brake setting can also be affected by discrete events that represent
    // brake charges, the emergency pull cord, and autostart commands.
    const brakesCanCharge = frp.liftN(
        (brakes, isCharging) => {
            return (
                brakes !== BrakeType.Emergency &&
                brakes !== BrakeType.None &&
                brakes[1] >= 1 - 0.05 && // max brake
                isCharging
            );
        },
        brakeCommand,
        () => (me.rv.GetControlValue("Charging", 0) as number) > 0.5
    );
    const chargeBrakes$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        frp.filter(_ => frp.snapshot(brakesCanCharge)),
        frp.map((pu): BrakeEvent => {
            const chargePerSecond = 0.063; // 10 seconds to recharge to service braking
            return [BrakeType.Charge, chargePerSecond * pu.dt];
        })
    );
    const emergencyBrakeEvent$ = frp.compose(
        emergencyPullCordEvent$,
        frp.map((_): BrakeCommand => BrakeType.Emergency)
    );
    const autostartBrakeEvent$ = frp.compose(
        autostartEvent$,
        frp.map(autostart => (autostart === ControlEvent.Autostart ? BrakeType.Autostart : BrakeType.Emergency))
    );
    const brakeCommandAndEvents$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        mapBehavior(brakeCommand),
        frp.merge(emergencyBrakeEvent$),
        frp.merge(autostartBrakeEvent$),
        frp.merge(chargeBrakes$),
        frp.hub()
    );
    // When placed into emergency, the brakes should stay in that state until
    // the brake pipe is discharged and the train has come to a stop.
    const emergencyBrakeCanRelease = frp.liftN(
        (speedMph, bpPsi) => speedMph < c.stopSpeed && bpPsi <= 0,
        speedoMph,
        brakePipePsi
    );
    const emergencyBrake$ = frp.compose(
        brakeCommandAndEvents$,
        frp.fold((accum, command) => {
            if (command === BrakeType.Emergency) {
                return true;
            } else if (command === BrakeType.Autostart) {
                return false;
            } else if (accum) {
                return !frp.snapshot(emergencyBrakeCanRelease);
            } else {
                return false;
            }
        }, false),
        frp.hub()
    );
    const emergencyBrake = frp.stepper(emergencyBrake$, false);
    // The commanded throttle setting depends on the position of the master
    // controller, the commanded brake setting, and the emergency brake latch.
    const throttleCommand = frp.liftN(
        (mc, brakes, emergencyBrake) => {
            if (brakes !== BrakeType.None) {
                return 0;
            } else if (emergencyBrake) {
                return 0;
            } else if (mc === undefined || mc === ControllerRegion.Coast || mc === ControllerRegion.EmergencyBrake) {
                return 0;
            } else {
                const [region, amount] = mc;
                return region === ControllerRegion.Power ? ((1 - 0.25) / (1 - 0)) * (amount - 1) + 1 : 0;
            }
        },
        masterController,
        brakeCommand,
        emergencyBrake
    );
    const throttle$ = frp.compose(me.createPlayerWithKeyUpdateStream(), mapBehavior(throttleCommand));
    // The physics value of the reverser should be one of three values.
    const reverser$ = frp.compose(
        userReverser$,
        frp.map(r => {
            switch (r) {
                case Reverser.Reverse:
                    return -1;
                case Reverser.Neutral:
                case Reverser.KeyOut:
                default:
                    return 0;
                case Reverser.Forward:
                    return 1;
            }
        })
    );
    // Simulate a lag time for dynamic braking and adjust the applied effort for
    // the length of the consist.
    const nMultipleUnits = () => Math.round(me.rv.GetConsistLength() / (85.5 * c.ft.toM));
    const dynamicBrakeCommand = frp.liftN(
        (brakes, emergencyBrake) => {
            if (emergencyBrake) {
                return 0;
            } else if (brakes === BrakeType.None || brakes === BrakeType.Emergency) {
                return 0;
            } else {
                return ((1 - 0.25) / (1 - 0)) * (brakes[1] - 1) + 1;
            }
        },
        brakeCommand,
        emergencyBrake
    );
    const dynamicBrake$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        // Simulate a lag time for the dynamics to ramp up and down.
        frp.fold<number, PlayerUpdate>((accum, pu) => {
            const target = frp.snapshot(dynamicBrakeCommand);
            const maxChangePerS = 0.25;
            if (target < accum) {
                return Math.max(accum - maxChangePerS * pu.dt, target);
            } else if (target > accum) {
                return Math.min(accum + maxChangePerS * pu.dt, target);
            } else {
                return target;
            }
        }, 0),
        // Physics are calibrated for a 12-car train.
        frp.map((v: number) => (v * frp.snapshot(nMultipleUnits)) / 12)
    );
    // Blend air brakes when in the service range and account for the emergency
    // brake latch.
    const airBrake$ = frp.compose(
        brakeCommandAndEvents$,
        me.foldAfterSettled(
            (accum, brakes) => {
                if (brakes === BrakeType.Emergency) {
                    return 1;
                } else if (frp.snapshot(emergencyBrake)) {
                    return 1;
                } else if (accum > airBrakeChargeThreshold) {
                    if (brakes === BrakeType.Autostart) {
                        return airBrakeChargeThreshold;
                    } else if (brakes !== BrakeType.None && brakes[0] === BrakeType.Charge) {
                        return accum - brakes[1];
                    } else {
                        return accum;
                    }
                } else {
                    if (brakes === BrakeType.None) {
                        return 0;
                    } else if (brakes !== BrakeType.Autostart && brakes[0] === BrakeType.Service) {
                        return airBrakeServiceRange(frp.snapshot(speedoMph) * c.mph.toMps, brakes[1]);
                    } else {
                        return accum;
                    }
                }
            },
            // TrainBrakeControl refuses to cooperate in a save/resume, so just
            // default to no brakes if already moving.
            () => (me.rv.GetSpeed() > c.stopSpeed ? 0 : airBrakeChargeThreshold)
        ),
        frp.hub()
    );
    throttle$(cv => {
        me.rv.SetControlValue("Regulator", 0, cv);
    });
    reverser$(cv => {
        me.rv.SetControlValue("Reverser", 0, cv);
    });
    dynamicBrake$(cv => {
        me.rv.SetControlValue("DynamicBrake", 0, cv);
    });
    airBrake$(cv => {
        me.rv.SetControlValue("TrainBrakeControl", 0, cv);
    });

    // Ensure consistent states for the startup (Z) and emergency brake
    // (Backspace) controls.
    const startupState$ = frp.compose(
        airBrake$,
        frp.map(applied => applied <= airBrakeChargeThreshold),
        fsm(false)
    );
    startupState$(([from, to]) => {
        if (!from && to) {
            me.rv.SetControlValue("VirtualStartup", 0, 1);
        } else if (from && !to) {
            me.rv.SetControlValue("VirtualStartup", 0, -1);
        }
    });
    emergencyPullCordEvent$(_ => {
        me.rv.SetControlValue("VirtualEmergencyBrake", 0, 0); // Reset if tripped
    });

    // Operating display indicators
    const nMultipleUnits$ = frp.compose(me.createPlayerWithKeyUpdateStream(), mapBehavior(nMultipleUnits));
    nMultipleUnits$(n => {
        me.rv.SetControlValue("Cars", 0, n);
    });

    // Driving display indicators
    const speedoMphDigits$ = frp.compose(speedoMph$, threeDigitDisplay);
    const brakePipePsiDigits$ = frp.compose(brakePipePsi$, threeDigitDisplay);
    const brakeCylinderPsiDigits$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        me.mapGetCvStream("TrainBrakeCylinderPressurePSI", 0),
        threeDigitDisplay
    );
    speedoMphDigits$(([digits, guide]) => {
        me.rv.SetControlValue("SpeedoHundreds", 0, digits[0]);
        me.rv.SetControlValue("SpeedoTens", 0, digits[1]);
        me.rv.SetControlValue("SpeedoUnits", 0, digits[2]);
        me.rv.SetControlValue("SpeedoGuide", 0, guide);
    });
    brakePipePsiDigits$(([digits, guide]) => {
        me.rv.SetControlValue("PipeHundreds", 0, digits[0]);
        me.rv.SetControlValue("PipeTens", 0, digits[1]);
        me.rv.SetControlValue("PipeUnits", 0, digits[2]);
        me.rv.SetControlValue("PipeGuide", 0, guide);
    });
    brakeCylinderPsiDigits$(([digits, guide]) => {
        me.rv.SetControlValue("CylinderHundreds", 0, digits[0]);
        me.rv.SetControlValue("CylinderTens", 0, digits[1]);
        me.rv.SetControlValue("CylinderUnits", 0, digits[2]);
        me.rv.SetControlValue("CylGuide", 0, guide);
    });
    emergencyBrake$(bie => {
        me.rv.SetControlValue("EmergencyBrakesIndicator", 0, bie ? 1 : 0);
    });

    // Screens on/off
    hasPower$(power => {
        me.rv.SetControlValue("ScreensOff", 0, !power ? 1 : 0);
    });

    // Headlight control
    const dimLights = [
        new rw.Light("Headlight_Dim_L"),
        new rw.Light("Headlight_Dim_R"),
        new rw.Light("Headlight_Dim_AuxL"),
        new rw.Light("Headlight_Dim_AuxR"),
    ];
    const brightLights = [
        new rw.Light("Headlight_Bright_L"),
        new rw.Light("Headlight_Bright_R"),
        new rw.Light("Headlight_Bright_AuxL"),
        new rw.Light("Headlight_Bright_AuxR"),
    ];
    const aiLights = [
        new rw.Light("Headlight_AI_L"),
        new rw.Light("Headlight_AI_R"),
        new rw.Light("Headlight_AI_AuxL"),
        new rw.Light("Headlight_AI_AuxR"),
    ];
    const aiHeadlights$ = frp.compose(
        me.createAiUpdateStream(),
        frp.map(au => {
            if (au.direction === SensedDirection.Forward) {
                const [frontCoupled] = au.couplings;
                return frontCoupled ? HeadLight.Off : HeadLight.BrightAi;
            } else {
                return HeadLight.Off;
            }
        })
    );
    const leadHeadlights$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        me.mapGetCvStream("Headlights", 0),
        frp.map(readHeadlightSetting)
    );
    const helperHeadlights$ = frp.compose(
        me.createPlayerWithoutKeyUpdateStream(),
        frp.map(_ => HeadLight.Off)
    );
    const headlights$ = frp.compose(aiHeadlights$, frp.merge(leadHeadlights$), frp.merge(helperHeadlights$));
    headlights$(setting => {
        for (const light of dimLights) {
            light.Activate(setting === HeadLight.Dim);
        }
        for (const light of brightLights) {
            light.Activate(setting === HeadLight.Bright);
        }
        for (const light of aiLights) {
            light.Activate(setting === HeadLight.BrightAi);
        }
    });

    // Marker light control
    const markerLights = [new rw.Light("Taillight_L"), new rw.Light("Taillight_R")];
    const aiMarkers$ = frp.compose(
        me.createAiUpdateStream(),
        frp.map(au => {
            if (au.direction === SensedDirection.Backward) {
                const [frontCoupled] = au.couplings;
                return !frontCoupled;
            } else {
                return false;
            }
        })
    );
    const leadMarkers$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        frp.map(_ => {
            const cv = me.rv.GetControlValue("Taillights", 0) as number;
            return cv > 0.5;
        })
    );
    const helperMarkers$ = frp.compose(
        me.createPlayerWithoutKeyUpdateStream(),
        frp.map(pu => {
            const [frontCoupled] = pu.couplings;
            return !frontCoupled;
        })
    );
    const markers$ = frp.compose(aiMarkers$, frp.merge(leadMarkers$), frp.merge(helperMarkers$));
    markers$(setting => {
        for (const light of markerLights) {
            light.Activate(setting);
        }
    });

    // Door hallway lights
    const hallLights = [new rw.Light("HallLight_001"), new rw.Light("HallLight_002")];
    const hallLightsPlayer$ = frp.compose(
        me.createPlayerUpdateStream(),
        frp.map(pu => {
            const [l, r] = pu.doorsOpen;
            return l || r;
        })
    );
    const hallLights$ = frp.compose(
        me.createAiUpdateStream(),
        frp.map(_ => false),
        frp.merge(hallLightsPlayer$)
    );
    hallLights$(on => {
        for (const light of hallLights) {
            light.Activate(on);
        }
    });

    // Door status lights
    const doorLightsPlayer$ = frp.compose(
        me.createPlayerUpdateStream(),
        frp.map((pu): [boolean, boolean] => pu.doorsOpen)
    );
    const doorLights$ = frp.compose(
        me.createAiUpdateStream(),
        frp.map((au): [boolean, boolean] => [au.isStopped, au.isStopped]),
        frp.merge(doorLightsPlayer$)
    );
    doorLights$(([l, r]) => {
        me.rv.ActivateNode("SL_doors_L", l);
        me.rv.ActivateNode("SL_doors_R", r);
    });

    // Cab dome light
    const cabLight = new rw.Light("Cablight");
    const noCabLight$ = frp.compose(
        me.createAiUpdateStream(),
        frp.merge(me.createPlayerWithoutKeyUpdateStream()),
        frp.map(_ => false)
    );
    const playerCabLight$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        me.mapGetCvStream("Cablight", 0),
        frp.map(v => v > 0.5)
    );
    const cabLightOn$ = frp.compose(noCabLight$, frp.merge(playerCabLight$));
    cabLightOn$(on => {
        cabLight.Activate(on);
    });

    // Passenger cabin lights for the passenger view
    let interiorPassLights = [new rw.Light("RoomLight_PassView")];
    for (let i = 1; i <= 9; i++) {
        interiorPassLights.push(new rw.Light(`RoomLight_0${i}`));
    }
    const isPassView$ = frp.compose(
        me.createOnCameraStream(),
        frp.map(vc => vc === VehicleCamera.Carriage)
    );
    const noInteriorPassLight$ = frp.compose(
        me.createAiUpdateStream(),
        frp.merge(me.createPlayerWithoutKeyUpdateStream()),
        frp.map(_ => false)
    );
    const playerInteriorPassLight$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        mapBehavior(frp.stepper(isPassView$, false))
    );
    const interiorPassLightOn$ = frp.compose(noInteriorPassLight$, frp.merge(playerInteriorPassLight$));
    interiorPassLightOn$(on => {
        for (const light of interiorPassLights) {
            light.Activate(on);
        }
    });

    // Brake cylinder status lights
    const aiBrakeLight$ = frp.compose(
        me.createAiUpdateStream(),
        frp.map(au => {
            if (au.direction === SensedDirection.None) {
                return BrakeLight.Amber;
            } else if (au.isStopped) {
                return BrakeLight.Amber;
            } else {
                return BrakeLight.Green;
            }
        })
    );
    const playerBrakeLight$ = frp.compose(
        me.createPlayerUpdateStream(),
        frp.map(_ => {
            const brakeCylPsi = me.rv.GetControlValue("TrainBrakeCylinderPressurePSI", 0) as number;
            if (brakeCylPsi > 34) {
                return BrakeLight.Amber;
            } else if (brakeCylPsi > 11) {
                return BrakeLight.Dark;
            } else {
                return BrakeLight.Green;
            }
        })
    );
    const brakeLight$ = frp.compose(aiBrakeLight$, frp.merge(playerBrakeLight$));
    brakeLight$(status => {
        me.rv.ActivateNode("SL_green", status === BrakeLight.Green);
        me.rv.ActivateNode("SL_yellow", status === BrakeLight.Amber);
        me.rv.ActivateNode("SL_blue", false);
    });

    // Wiper control
    const aiWiperUpdate$ = frp.compose(
        me.createAiUpdateStream(),
        frp.map((au): WiperUpdate => {
            const [frontCoupled] = au.couplings;
            const isRaining = rw.WeatherController.GetPrecipitationDensity() > 0;
            const setting =
                isRaining && au.direction === SensedDirection.Forward && !frontCoupled ? WiperMode.Low : WiperMode.Off;
            return [setting, au.dt];
        })
    );
    const leadWiperUpdate$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        frp.map((pu): WiperUpdate => {
            const cv = me.rv.GetControlValue("Wipers", 0) as number;
            return [readWiperSetting(cv), pu.dt];
        })
    );
    const helperWiperUpdate$ = frp.compose(
        me.createPlayerWithoutKeyUpdateStream(),
        frp.map((pu): WiperUpdate => [WiperMode.Off, pu.dt])
    );
    const wiperPosition$ = frp.compose(
        aiWiperUpdate$,
        frp.merge(leadWiperUpdate$),
        frp.merge(helperWiperUpdate$),
        frp.fold<WiperAccum, WiperUpdate>(
            ([mode, cycleS], [setting, dt]) => {
                if (
                    mode === setting ||
                    (mode === WiperMode.Int3 && cycleS > 8) ||
                    (mode === WiperMode.Int2 && cycleS > 5) ||
                    (mode === WiperMode.Int1 && cycleS > 2) ||
                    (mode === WiperMode.Low && cycleS > 0) ||
                    (mode === WiperMode.High && cycleS > 0)
                ) {
                    const wrapS = {
                        [WiperMode.Int3]: 8 + 2,
                        [WiperMode.Int2]: 5 + 2,
                        [WiperMode.Int1]: 2 + 2,
                        [WiperMode.Off]: 0,
                        [WiperMode.Low]: 2,
                        [WiperMode.High]: 1.6,
                    }[mode];
                    const nextS = cycleS + dt;
                    return [mode, nextS < wrapS ? nextS : 0];
                } else {
                    return [setting, 0];
                }
            },
            [WiperMode.Off, 0]
        ),
        frp.map(([mode, cycleS]) => {
            if (mode === WiperMode.Int3) {
                if (cycleS >= 9) {
                    return 10 - cycleS;
                } else if (cycleS >= 8) {
                    return cycleS - 8;
                } else {
                    return 0;
                }
            } else if (mode === WiperMode.Int2) {
                if (cycleS >= 6) {
                    return 7 - cycleS;
                } else if (cycleS >= 5) {
                    return cycleS - 5;
                } else {
                    return 0;
                }
            } else if (mode === WiperMode.Int1) {
                if (cycleS >= 3) {
                    return 4 - cycleS;
                } else if (cycleS >= 2) {
                    return cycleS - 2;
                } else {
                    return 0;
                }
            } else if (mode === WiperMode.Low) {
                return cycleS >= 1 ? 2 - cycleS : cycleS;
            } else if (mode === WiperMode.High) {
                return (cycleS >= 0.8 ? 1.6 - cycleS : cycleS) * 1.25;
            } else {
                return 0;
            }
        })
    );
    wiperPosition$(pos => {
        me.rv.SetTime("ext_wipers", pos);
        me.rv.SetControlValue("WipersPosition", 0, pos);
    });

    // Sync virtual and in-cab wiper controls.
    const hudWiperChange$ = frp.compose(
        me.createOnCvChangeStreamFor("VirtualWipers", 0),
        frp.filter(cv => cv <= 0 || cv >= 1),
        frp.map(cv => cv >= 1)
    );
    const cabWiperChange$ = frp.compose(
        me.createOnCvChangeStreamFor("Wipers", 0),
        frp.map(cv => readWiperSetting(cv))
    );
    hudWiperChange$(on => {
        me.rv.SetControlValue("Wipers", 0, on ? 0.2 : 0); // low/off
    });
    cabWiperChange$(setting => {
        me.rv.SetControlValue("VirtualWipers", 0, setting === WiperMode.Off ? 0 : 1);
    });

    // Hide passengers if the "No Passengers" destination is selected.
    const passengers = new rw.RenderedEntity("Passengers");
    const showPassengers$ = frp.compose(
        me.createUpdateStream(),
        frp.map(_ => string.sub(me.rv.GetRVNumber(), 1, 1) !== "z")
    );
    showPassengers$(show => {
        passengers.ActivateNode("all", show);
    });

    // Ambient sounds (HVAC, etc.)
    me.rv.SetControlValue("AmbientSound", 0, 1);

    // Master controller and reverser positions default to coast and neutral,
    // which isn't allowed by the initial interlocking state. Mute clicks for
    // these controls when first entering the cab.
    const setupMuteS = 1;
    const insideCab$ = frp.compose(
        me.createOnCameraStream(),
        frp.map(vc => vc === VehicleCamera.FrontCab)
    );
    const insideCab = frp.stepper(insideCab$, false);
    const isSetupInsideCab$ = frp.compose(
        me.createPlayerWithKeyUpdateStream(),
        frp.fold(
            (countdownS, pu) => (frp.snapshot(insideCab) ? Math.max(countdownS - pu.dt, 0) : countdownS),
            setupMuteS
        ),
        frp.map(countdownS => countdownS <= 0)
    );
    const isNotSetup$ = frp.compose(
        me.createAiUpdateStream(),
        frp.merge(me.createPlayerWithoutKeyUpdateStream()),
        frp.map(_ => false)
    );
    const enableControlSounds$ = frp.compose(isSetupInsideCab$, frp.merge(isNotSetup$));
    enableControlSounds$(on => {
        me.rv.SetControlValue("IsPlayerControl", 0, on ? 1 : 0);
    });

    // Force the pantograph on to allow driving on routes with overhead electrification.
    me.createPlayerWithKeyUpdateStream()(_ => {
        me.rv.SetControlValue("PantographControl", 0, 1);
        me.rv.SetControlValue("VirtualPantographControl", 0, 0);
    });

    // Process OnControlValueChange events.
    const onCvChange$ = frp.compose(
        me.createOnCvChangeStream(),
        frp.reject(([name]) => name === "MasterKey" || name === "UserVirtualReverser" || name === "ThrottleAndBrake")
    );
    onCvChange$(([name, index, value]) => me.rv.SetControlValue(name, index, value));

    // Sync headlight controls.
    const setVirtualHeadlights$ = frp.compose(
        me.createOnCvChangeStreamFor("Headlights", 0),
        frp.filter(v => v === Math.floor(v)),
        frp.map(readHeadlightSetting),
        frp.map(hl => {
            switch (hl) {
                case HeadLight.Off:
                    return 0;
                case HeadLight.Dim:
                    return 1;
                case HeadLight.Bright:
                    return 2;
            }
        })
    );
    setVirtualHeadlights$(v => {
        me.rv.SetControlValue("VirtualHeadlights", 0, v);
    });
    const setHeadlights$ = frp.compose(
        me.createOnCvChangeStreamFor("VirtualHeadlights", 0),
        frp.map(cv => {
            switch (cv) {
                case 2:
                    return HeadLight.Bright;
                case 1:
                    return HeadLight.Dim;
                case 0:
                    return HeadLight.Off;
                default:
                    return undefined;
            }
        }),
        rejectUndefined(),
        frp.map(hl => {
            switch (hl) {
                case HeadLight.Dim:
                    return 0;
                case HeadLight.Off:
                    return 1;
                case HeadLight.Bright:
                    return 2;
            }
        })
    );
    setHeadlights$(v => {
        me.rv.SetControlValue("Headlights", 0, v);
    });

    // Enable updates.
    me.activateUpdatesEveryFrame(true);
});
me.setup();

function createCutInBehavior(e: FrpEngine, name: string, index: number) {
    return () => (e.rv.GetControlValue(name, index) as number) > 0.5;
}

function threeDigitDisplay(eventStream: frp.Stream<number>) {
    return frp.compose(
        eventStream,
        frp.map(n => Math.round(Math.abs(n))),
        frp.map(n => m.digits(n, 3))
    );
}

function airBrakeServiceRange(speedMps: number, application: number) {
    const aSpeedMps = Math.abs(speedMps);
    const transitionMph: [start: number, end: number] = [1.341, 3.576]; // from 3 to 8 mph
    const minService = 0.048; // 13 psi BC
    const maxService = 0.137; // 43 psi BC
    const floor = 0.035; // 8 psi BC
    let proportion;
    if (aSpeedMps < transitionMph[0]) {
        proportion = 1;
    } else if (aSpeedMps < transitionMph[1]) {
        proportion = (-1 / (transitionMph[1] - transitionMph[0])) * (aSpeedMps - transitionMph[1]);
    } else {
        proportion = 0;
    }
    return Math.max((((maxService - minService) / (1 - 0)) * (application - 0) + minService) * proportion, floor);
}

function readHeadlightSetting(cv: number) {
    if (cv > 1.5) {
        return HeadLight.Bright;
    } else if (cv > 0.5) {
        return HeadLight.Off;
    } else {
        return HeadLight.Dim;
    }
}

function readWiperSetting(cv: number) {
    if (cv < -0.5) {
        return WiperMode.Int3;
    } else if (cv < -0.3) {
        return WiperMode.Int2;
    } else if (cv < -0.1) {
        return WiperMode.Int1;
    } else if (cv < 0.1) {
        return WiperMode.Off;
    } else if (cv < 0.3) {
        return WiperMode.Low;
    } else {
        return WiperMode.High;
    }
}
