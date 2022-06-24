/** @noSelfInFile */

import * as acses from "../../../../../../../../lib/acses";
import * as ale from "../../../../../../../../lib/alerter";
import * as asc from "../../../../../../../../lib/asc";
import * as cs from "../../../../../../../../lib/cabsignals";
import * as c from "../../../../../../../../lib/constants";
import * as dest from "../../../../../../../../lib/destinations";
import * as frp from "../../../../../../../../lib/frp";
import { FrpEngine } from "../../../../../../../../lib/frp-engine";
import { debug, fsm, rejectUndefined } from "../../../../../../../../lib/frp-extra";
import { VehicleAuthority, VehicleCamera } from "../../../../../../../../lib/frp-vehicle";
import * as m from "../../../../../../../../lib/math";
import * as rw from "../../../../../../../../lib/railworks";

enum ControlEvent {
    Autostart,
    Autostop,
    EmergencyBrake,
}

enum InterlockAllows {
    MasterKeyIn,
    MasterKeyOutReverserNonKeyOut,
    ReverserKeyOutMasterControllerNonEmergency,
    MasterControllerEmergency,
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

type BrakeCommand = BrakeType.None | [BrakeType.Service, number] | BrakeType.Emergency;
type BrakeEvent = BrakeType.Emergency | BrakeType.Autostart | [BrakeType.Charge, number];
enum BrakeType {
    None,
    Service,
    Emergency,
    Charge,
    Autostart,
}

enum BrakeLight {
    Green,
    Amber,
    Dark,
}

const me = new FrpEngine(() => {
    // Useful streams and behaviors
    const speedoMph$ = me.createGetCvStream("SpeedometerMPH", 0);
    const speedoMph = frp.stepper(speedoMph$, 0);
    const brakePipePsi$ = me.createGetCvStream("AirBrakePipePressurePSI", 0);
    const brakePipePsi = frp.stepper(brakePipePsi$, 0);
    const trueSpeedMps = () => me.rv.GetSpeed();
    const isTrueStopped = () => frp.snapshot(trueSpeedMps) < c.stopSpeed;
    const authority = frp.stepper(me.createAuthorityStream(), VehicleAuthority.IsPlayer);

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
        frp.fold((accum, input) => {
            switch (input) {
                case ControlEvent.Autostart:
                    return InterlockAllows.MasterControllerEmergency;
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
                        return InterlockAllows.MasterKeyOutReverserNonKeyOut;
                    }
                    break;
                case InterlockAllows.MasterKeyOutReverserNonKeyOut:
                    if (name === "MasterKey" && value < 0.5) {
                        return InterlockAllows.MasterKeyIn;
                    } else if (name === "UserVirtualReverser" && value < 2.5) {
                        return InterlockAllows.ReverserKeyOutMasterControllerNonEmergency;
                    }
                    break;
                case InterlockAllows.ReverserKeyOutMasterControllerNonEmergency:
                    if (name === "UserVirtualReverser" && value > 2.5) {
                        return InterlockAllows.MasterKeyOutReverserNonKeyOut;
                    } else if (name === "ThrottleAndBrake" && value > -0.95) {
                        return InterlockAllows.MasterControllerEmergency;
                    }
                    break;
                case InterlockAllows.MasterControllerEmergency:
                default:
                    if (name === "ThrottleAndBrake" && value < -0.95) {
                        return InterlockAllows.ReverserKeyOutMasterControllerNonEmergency;
                    }
                    break;
            }
            return accum;
        }, InterlockAllows.MasterKeyIn)
    );
    const interlockState = frp.stepper(interlockState$, InterlockAllows.MasterKeyIn);

    // "Write back" values to interlocked controls so that they cannot be
    // manipulated by the player. We also process autostart events here.
    const rwMasterController$ = frp.compose(
        autostartEvent$,
        frp.map(evt => (evt === ControlEvent.Autostart ? -0.9 : -1)),
        frp.merge(me.createGetCvAndOnCvChangeStreamFor("ThrottleAndBrake", 0)),
        frp.map(cv => {
            switch (frp.snapshot(interlockState)) {
                case InterlockAllows.MasterKeyIn:
                case InterlockAllows.MasterKeyOutReverserNonKeyOut:
                    return -1;
                case InterlockAllows.ReverserKeyOutMasterControllerNonEmergency:
                case InterlockAllows.MasterControllerEmergency:
                    return cv;
            }
        }),
        frp.hub()
    );
    const rwReverser$ = frp.compose(
        autostartEvent$,
        frp.map(evt => (evt === ControlEvent.Autostart ? 1 : 3)),
        frp.merge(me.createGetCvAndOnCvChangeStreamFor("UserVirtualReverser", 0)),
        frp.map(cv => {
            switch (frp.snapshot(interlockState)) {
                case InterlockAllows.MasterKeyIn:
                    return 3;
                case InterlockAllows.MasterKeyOutReverserNonKeyOut:
                case InterlockAllows.ReverserKeyOutMasterControllerNonEmergency:
                    return cv;
                case InterlockAllows.MasterControllerEmergency:
                    return Math.min(cv, 2);
            }
        }),
        frp.hub()
    );
    const rwMasterKey$ = frp.compose(
        autostartEvent$,
        frp.map(evt => (evt === ControlEvent.Autostart ? 1 : 0)),
        frp.merge(me.createGetCvAndOnCvChangeStreamFor("MasterKey", 0)),
        frp.map(cv => {
            switch (frp.snapshot(interlockState)) {
                case InterlockAllows.MasterKeyIn:
                case InterlockAllows.MasterKeyOutReverserNonKeyOut:
                    return cv;
                case InterlockAllows.ReverserKeyOutMasterControllerNonEmergency:
                case InterlockAllows.MasterControllerEmergency:
                    return 1;
            }
        }),
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
    const masterController = frp.stepper(masterController$, ControllerRegion.EmergencyBrake);
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
        return (
            mc === ControllerRegion.EmergencyBrake ||
            mc === ControllerRegion.Coast ||
            mc[0] === ControllerRegion.ServiceBrake
        );
    };

    // Pulse code cab signaling
    const cabSignal$ = frp.compose(
        me.createOnCustomSignalMessageStream(),
        frp.map(msg => cs.toPulseCode(msg)),
        rejectUndefined(),
        frp.map(pc => cs.toLirrAspect(pc))
    );
    const setSignalSpeed$ = me.createUpdateStreamForBehavior(
        frp.liftN(
            (aspect, hasPower) =>
                hasPower
                    ? {
                          [cs.LirrAspect.Speed15]: 15,
                          [cs.LirrAspect.Speed30]: 30,
                          [cs.LirrAspect.Speed40]: 40,
                          [cs.LirrAspect.Speed60]: 60,
                          [cs.LirrAspect.Speed70]: 70,
                          [cs.LirrAspect.Speed80]: 80,
                      }[aspect]
                    : 0,
            frp.stepper(cabSignal$, cs.LirrAspect.Speed15),
            hasPower
        )
    );
    setSignalSpeed$(cv => me.rv.SetControlValue("SignalSpeedLimit", 0, cv));

    // Alerter (ALE) vigilance subsystem
    const aleActivity = frp.liftN(
        (acknowledge, mc, horn) => {
            const maxBrakeOrEmergency =
                mc === ControllerRegion.EmergencyBrake ||
                (mc !== ControllerRegion.Coast && mc[0] === ControllerRegion.ServiceBrake && mc[1] >= 1);
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
        me.createUpdateStreamForBehavior(aleActivity),
        frp.filter(v => v),
        frp.map(_ => ale.AlerterInput.Activity),
        frp.merge(aleInputCancelsPenalty$)
    );
    const aleCutIn$ = createCutInStream(me, "ALECutIn", 0);
    const ale$ = frp.compose(ale.create(me, aleInput$, aleCutIn$, hasPower), frp.hub());
    const aleState = frp.stepper(ale$, ale.initState);
    ale$(state => {
        me.rv.SetControlValue("AlerterIndicator", 0, state.alarm ? 1 : 0);
        me.rv.SetControlValue("ALEAlarm", 0, state.alarm ? 1 : 0);
    });

    // ASC signal speed enforcement subsystem
    const ascCutIn$ = createCutInStream(me, "ATCCutIn", 0);
    const ascStatus$ = me.createUpdateStreamForBehavior(
        frp.liftN(
            (cutIn, hasPower) => {
                if (hasPower) {
                    return cutIn ? 1 : 0;
                } else {
                    return -1;
                }
            },
            frp.stepper(ascCutIn$, false),
            hasPower
        )
    );
    const asc$ = frp.compose(asc.create(me, cabSignal$, acknowledge, coastOrBrake, ascCutIn$, hasPower), frp.hub());
    const ascState = frp.stepper(asc$, asc.initState);
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
    const acsesCutIn$ = createCutInStream(me, "ACSESCutIn", 0);
    const acsesStatus$ = me.createUpdateStreamForBehavior(
        frp.liftN(
            (cutIn, hasPower) => {
                if (hasPower) {
                    return cutIn ? 2 : 0;
                } else {
                    return -1;
                }
            },
            frp.stepper(acsesCutIn$, false),
            hasPower
        )
    );
    const acses$ = frp.compose(acses.create(me, acknowledge, coastOrBrake, acsesCutIn$, hasPower), frp.hub());
    const acsesState = frp.stepper(acses$, acses.initState);
    const acsesBeep$ = frp.compose(
        acses$,
        fsm(acses.initState),
        frp.filter(
            ([from, to]) => from.trackSpeedMps !== to.trackSpeedMps && to.trackSpeedMps !== undefined && !to.overspeed
        ),
        me.createEventStreamTimer(),
        frp.map(onOff => (onOff ? 1 : 0))
    );
    acsesStatus$(status => {
        me.rv.SetControlValue("ACSESStatus", 0, status);
    });
    acses$(state => {
        me.rv.SetControlValue("ACSESPenalty", 0, state.brakes !== acses.AcsesBrake.None ? 1 : 0);
        me.rv.SetControlValue("ACSESAlarm", 0, state.alarm ? 1 : 0);
        me.rv.SetControlValue("ACSESStop", 0, state.brakes === acses.AcsesBrake.PositiveStop ? 1 : 0);

        let os;
        if (state.overspeed) {
            os = state.brakes === acses.AcsesBrake.None ? 1 : 2;
        } else {
            os = 0;
        }
        me.rv.SetControlValue("ACSESOverspeed", 0, os);

        let h, t, u;
        if (state.trackSpeedMps === undefined) {
            [h, t, u] = [-1, -1, -1];
        } else {
            [[h, t, u]] = m.digits(Math.round(state.trackSpeedMps * c.mps.toMph), 3);
        }
        me.rv.SetControlValue("TrackSpeedHundreds", 0, h);
        me.rv.SetControlValue("TrackSpeedTens", 0, t);
        me.rv.SetControlValue("TrackSpeedUnits", 0, u);
        me.rv.SetControlValue("TrackSpeedDashes", 0, 0);
    });
    acsesBeep$(cv => {
        me.rv.SetControlValue("ACSESBeep", 0, cv);
    });

    // Set the common penalty brake indicator.
    const isAnyPenalty$ = me.createUpdateStreamForBehavior(
        frp.liftN(
            (aleState, ascState, acsesState) => {
                switch (aleState.brakes) {
                    case ale.AlerterBrake.Penalty:
                        return true;
                    default:
                        break;
                }
                switch (ascState.brakes) {
                    case asc.AscBrake.Penalty:
                    case asc.AscBrake.MaxService:
                        return true;
                    default:
                        break;
                }
                switch (acsesState.brakes) {
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
    );
    isAnyPenalty$(penalty => {
        me.rv.SetControlValue("PenaltyIndicator", 0, penalty ? 1 : 0);
    });

    // Show the exclamation symbol on the HUD for any audible alarm.
    const isAnyAlarm$ = me.createUpdateStreamForBehavior(
        frp.liftN(
            (aleState, ascState, acsesState) => aleState.alarm || ascState.alarm || acsesState.alarm,
            aleState,
            ascState,
            acsesState
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
            if (ascState.brakes === asc.AscBrake.Emergency || mc === ControllerRegion.EmergencyBrake) {
                return BrakeType.Emergency;
            } else if (
                aleState.brakes === ale.AlerterBrake.Penalty ||
                ascState.brakes === asc.AscBrake.Penalty ||
                ascState.brakes === asc.AscBrake.MaxService ||
                acsesState.brakes === acses.AcsesBrake.Penalty ||
                acsesState.brakes === acses.AcsesBrake.PositiveStop
            ) {
                return [BrakeType.Service, 1];
            } else if (mc === ControllerRegion.Coast || mc[0] === ControllerRegion.Power) {
                return BrakeType.None;
            } else {
                return [BrakeType.Service, mc[1]];
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
        me.createUpdateStream(),
        me.filterPlayerEngine(),
        fsm(0),
        frp.map(([from, to]) => {
            const chargePerSecond = 0.063; // 10 seconds to recharge to service braking
            return frp.snapshot(brakesCanCharge) ? chargePerSecond * (to - from) : 0;
        }),
        frp.filter(charge => charge > 0),
        frp.map((charge): BrakeEvent => [BrakeType.Charge, charge])
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
        me.createUpdateStreamForBehavior(brakeCommand),
        me.filterPlayerEngine(),
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
            } else if (
                mc !== ControllerRegion.Coast &&
                mc !== ControllerRegion.EmergencyBrake &&
                mc[0] !== ControllerRegion.ServiceBrake
            ) {
                return ((1 - 0.25) / (1 - 0)) * (mc[1] - 1) + 1;
            } else {
                return 0;
            }
        },
        masterController,
        brakeCommand,
        emergencyBrake
    );
    const throttle$ = frp.compose(me.createUpdateStreamForBehavior(throttleCommand), me.filterPlayerEngine());
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
        me.createUpdateStream(),
        me.filterPlayerEngine(),
        fsm(0),
        frp.map(([from, to]): [dt: number, target: number] => [to - from, frp.snapshot(dynamicBrakeCommand)]),
        // Simulate an exponential lag time for the dynamics to kick in.
        frp.fold<number, [dt: number, target: number]>((accum, input) => {
            const [dt, target] = input;
            const maxChangePerS = ((1 - 0.25) / (1 - 0)) * (accum - 0) + 0.25;
            return target <= accum ? target : Math.min(accum + maxChangePerS * dt, target);
        }, 0),
        // Physics are calibrated for a 12-car train.
        frp.map((v: number) => (v * frp.snapshot(nMultipleUnits)) / 12)
    );
    // Blend air brakes when in the service range and account for the emergency
    // brake latch.
    const airBrake$ = frp.compose(
        brakeCommandAndEvents$,
        frp.fold((accum, brakes) => {
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
        }, 1),
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

    // Driving display indicators
    const speedoMphDigits$ = frp.compose(speedoMph$, me.filterPlayerEngine(), threeDigitDisplay),
        brakePipePsiDigits$ = frp.compose(brakePipePsi$, me.filterPlayerEngine(), threeDigitDisplay),
        brakeCylinderPsiDigits$ = frp.compose(
            me.createGetCvStream("TrainBrakeCylinderPressurePSI", 0),
            me.filterPlayerEngine(),
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
    hasPower$(power => me.rv.SetControlValue("ScreensOff", 0, !power ? 1 : 0));

    // Cab dome light
    const cabLight = new rw.Light("Cablight");
    const cabLightOn$ = frp.compose(
        me.createOnCvChangeStreamFor("Cablight", 0),
        frp.map(v => v > 0.5)
    );
    cabLightOn$(on => cabLight.Activate(on));
    cabLight.Activate(false);

    // Passenger cabin lights
    const passLight = new rw.Light("RoomLight_PassView");
    const passLightOn$ = frp.compose(
        me.createCameraStream(),
        frp.map(vc => vc === VehicleCamera.Carriage)
    );
    passLightOn$(on => passLight.Activate(on));
    passLight.Activate(false);

    // Brake cylinder status lights
    const brakeLight$ = me.createUpdateStreamForBehavior(
        frp.liftN(
            (authority, speedMps, brakeCylPsi) => {
                if (authority === VehicleAuthority.IsPlayer) {
                    if (brakeCylPsi <= 12) {
                        return BrakeLight.Green;
                    } else if (brakeCylPsi <= 15) {
                        return BrakeLight.Dark;
                    } else {
                        return BrakeLight.Amber;
                    }
                } else if (authority === VehicleAuthority.IsAiParked) {
                    return BrakeLight.Amber;
                } else {
                    const isSlow = Math.abs(speedMps) < 15 * c.mph.toMps;
                    return isSlow ? BrakeLight.Amber : BrakeLight.Green;
                }
            },
            authority,
            trueSpeedMps,
            () => me.rv.GetControlValue("TrainBrakeCylinderPressurePSI", 0) as number
        )
    );
    brakeLight$(status => {
        me.rv.ActivateNode("SL_green", status === BrakeLight.Green);
        me.rv.ActivateNode("SL_yellow", status === BrakeLight.Amber);
    });
    me.rv.ActivateNode("SL_blue", false);

    // Door open lights
    const leftDoorOpen$ = me.createUpdateStreamForBehavior(
        frp.liftN(
            (authority, stopped, playerDoor) => (authority === VehicleAuthority.IsPlayer ? playerDoor : stopped),
            authority,
            isTrueStopped,
            () => (me.rv.GetControlValue("DoorsOpenCloseLeft", 0) as number) > 0.5
        )
    );
    const rightDoorOpen$ = me.createUpdateStreamForBehavior(
        frp.liftN(
            (authority, stopped, playerDoor) => (authority === VehicleAuthority.IsPlayer ? playerDoor : stopped),
            authority,
            isTrueStopped,
            () => (me.rv.GetControlValue("DoorsOpenCloseRight", 0) as number) > 0.5
        )
    );
    leftDoorOpen$(open => {
        me.rv.ActivateNode("SL_doors_L", open);
    });
    rightDoorOpen$(open => {
        me.rv.ActivateNode("SL_doors_R", open);
    });

    // Destination board selector
    const previousDest$ = frp.compose(
        me.createGetCvStream("DecreaseDestination", 0),
        frp.filter(cv => cv > 0.5),
        frp.throttle(250)
    );
    const nextDest$ = frp.compose(
        me.createGetCvStream("IncreaseDestination", 0),
        frp.filter(cv => cv > 0.5),
        frp.throttle(250)
    );
    dest.setup(
        me,
        [
            "Atlantic Terminal Bklyn",
            "Penn Station",
            "Long Island City",
            "Hunterspoint Ave.",
            "Jamaica",
            "Ronkonkoma",
            "Huntington",
            "Hempstead",
            "Belmont Park",
            "Babylon",
            "Long Beach",
            "Far Rockaway",
            "West Hempstead",
            "Port Washington",
            "Great Neck",
            "Hicksville",
            "Mets-Willets Point",
            "No Passengers",
            "Valley Stream",
            "Freeport",
            "East Williston",
            "Farmingdale",
            "Grand Central",
            "Brentwood",
            "Massapequa",
        ],
        previousDest$,
        nextDest$
    );

    // Air conditioning sounds
    hasPower$(power => {
        me.rv.SetControlValue("FanSound", 0, power ? 1 : 0);
        me.rv.SetControlValue("AuxMotors", 0, power ? 1 : 0);
        me.rv.SetControlValue("CompressorState", 0, power ? 1 : 0);
    });

    // Force the pantograph on to allow driving on routes with overhead electrification.
    const setPantograph$ = frp.compose(me.createUpdateStream(), me.filterPlayerEngine());
    setPantograph$(_ => {
        me.rv.SetControlValue("PantographControl", 0, 1);
        me.rv.SetControlValue("VirtualPantographControl", 0, 0);
    });

    // Process OnControlValueChange events.
    const onCvChange$ = frp.compose(
        me.createOnCvChangeStream(),
        frp.reject(([name]) => name === "MasterKey" || name === "UserVirtualReverser" || name === "ThrottleAndBrake")
    );
    onCvChange$(([name, index, value]) => me.rv.SetControlValue(name, index, value));

    // Enable updates.
    me.activateUpdatesEveryFrame(true);
});
me.setup();

function createCutInStream(e: FrpEngine, name: string, index: number) {
    return frp.compose(
        e.createOnCvChangeStreamFor(name, index),
        frp.map(v => v > 0.5)
    );
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
