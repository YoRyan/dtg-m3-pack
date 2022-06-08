/** @noSelfInFile */

import * as acses from "../../../../../../../../lib/acses";
import * as ale from "../../../../../../../../lib/alerter";
import * as asc from "../../../../../../../../lib/asc";
import * as cs from "../../../../../../../../lib/cabsignals";
import * as c from "../../../../../../../../lib/constants";
import * as frp from "../../../../../../../../lib/frp";
import { FrpEngine } from "../../../../../../../../lib/frp-engine";
import { debug, fsm, rejectUndefined } from "../../../../../../../../lib/frp-extra";
import { VehicleAuthority, VehicleCamera } from "../../../../../../../../lib/frp-vehicle";
import * as m from "../../../../../../../../lib/math";
import * as rw from "../../../../../../../../lib/railworks";

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
    function forPlayerEngine<T>(): (eventStream: frp.Stream<T>) => frp.Stream<T> {
        return frp.filter((_: T) => me.eng.GetIsEngineWithKey());
    }

    function createCutInStream(name: string, index: number) {
        return frp.compose(
            me.createOnCvChangeStreamFor(name, index),
            frp.map((v: number) => v > 0.5)
        );
    }

    // Define some useful streams and behaviors.
    const authority$ = me.createAuthorityStream(),
        authority = frp.stepper(authority$, VehicleAuthority.IsPlayer),
        trueSpeedMps = () => me.rv.GetSpeed(),
        masterKey$ = frp.compose(
            me.createGetCvStream("MasterKey", 0),
            frp.map((cv: number) => cv > 0.5)
        ),
        masterKey = frp.stepper(masterKey$, false),
        masterController$ = frp.compose(
            me.createGetCvStream("ThrottleAndBrake", 0),
            frp.map((cv: number): MasterController => {
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
        ),
        masterController = frp.stepper(masterController$, ControllerRegion.EmergencyBrake),
        reverser$ = frp.compose(
            me.createGetCvStream("UserVirtualReverser", 0),
            frp.map((cv: number) => {
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
        ),
        reverser = frp.stepper(reverser$, Reverser.KeyOut),
        acknowledge = () => (me.rv.GetControlValue("AWSReset", 0) as number) > 0.5,
        coastOrBrake = () => {
            const mc = frp.snapshot(masterController);
            return (
                mc === ControllerRegion.EmergencyBrake ||
                mc === ControllerRegion.Coast ||
                mc[0] === ControllerRegion.ServiceBrake
            );
        },
        brakePipePsi$ = me.createGetCvStream("AirBrakePipePressurePSI", 0),
        brakePipePsi = frp.stepper(brakePipePsi$, 0);

    // Lock controls as necessary for the startup sequence.
    const lockMasterKeyOn$ = frp.compose(
            me.createUpdateStream(),
            frp.filter((_: number) => frp.snapshot(reverser) !== Reverser.KeyOut)
        ),
        lockReverserKeyOut$ = frp.compose(
            me.createUpdateStream(),
            frp.filter((_: number) => !frp.snapshot(masterKey))
        ),
        lockReverserOutOfEmergency$ = frp.compose(
            me.createUpdateStream(),
            frp.filter((_: number) => frp.snapshot(masterController) !== ControllerRegion.EmergencyBrake),
            frp.map(_ => me.rv.GetControlValue("UserVirtualReverser", 0) as number)
        ),
        lockMasterControllerKeyOut = frp.compose(
            me.createUpdateStream(),
            frp.filter((_: number) => frp.snapshot(reverser) === Reverser.KeyOut)
        );
    lockMasterKeyOn$(_ => {
        me.rv.SetControlValue("MasterKey", 0, 1);
    });
    lockReverserKeyOut$(_ => {
        me.rv.SetControlValue("UserVirtualReverser", 0, 3);
    });
    lockReverserOutOfEmergency$(cv => {
        me.rv.SetControlValue("UserVirtualReverser", 0, Math.min(cv, 2));
    });
    lockMasterControllerKeyOut(_ => {
        me.rv.SetControlValue("ThrottleAndBrake", 0, -1);
    });

    // Configure and initialize safety systems.
    const cabSignal$ = frp.compose(
            me.createOnCustomSignalMessageStream(),
            frp.map((msg: string) => cs.toPulseCode(msg)),
            rejectUndefined(),
            frp.map(pc => cs.toLirrAspect(pc))
        ),
        cabAspect = frp.stepper(cabSignal$, cs.LirrAspect.Speed15),
        signalSpeedControl = frp.liftN(
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
            cabAspect,
            masterKey
        ),
        setSignalSpeed$ = frp.compose(
            cabSignal$,
            frp.merge<boolean, number>(masterKey$),
            frp.map(_ => frp.snapshot(signalSpeedControl))
        );
    setSignalSpeed$(cv => me.rv.SetControlValue("SignalSpeedLimit", 0, cv));

    const aleCutIn$ = createCutInStream("ALECutIn", 0),
        movingPastCoast$ = frp.compose(
            masterController$,
            fsm<MasterController>(ControllerRegion.Coast),
            frp.filter(
                ([from, to]) => from !== to && (from === ControllerRegion.Coast || to === ControllerRegion.Coast)
            )
        ),
        aleInputCancelsPenalty$ = frp.map(_ => ale.AlerterInput.ActivityThatCancelsPenalty)(movingPastCoast$),
        isMaxBrakeOrEmergency = () => {
            const mc = frp.snapshot(masterController);
            return (
                mc === ControllerRegion.EmergencyBrake ||
                (mc !== ControllerRegion.Coast && mc[0] === ControllerRegion.ServiceBrake && mc[1] >= 1)
            );
        },
        horn = () => (me.rv.GetControlValue("Horn", 0) as number) > 0.5,
        aleInput$ = frp.compose(
            me.createUpdateStream(),
            frp.filter(
                (_: number) => frp.snapshot(isMaxBrakeOrEmergency) || frp.snapshot(acknowledge) || frp.snapshot(horn)
            ),
            frp.map(_ => ale.AlerterInput.Activity),
            frp.merge(aleInputCancelsPenalty$)
        ),
        ale$ = frp.hub<ale.AlerterState>()(ale.create(me, aleInput$, aleCutIn$, masterKey)),
        aleAlarm$ = frp.map((state: ale.AlerterState) => state.alarm)(ale$);
    aleAlarm$(alarm => {
        me.rv.SetControlValue("AlerterIndicator", 0, alarm ? 1 : 0);
        me.rv.SetControlValue("ALEAlarm", 0, alarm ? 1 : 0);
    });

    const ascCutIn$ = createCutInStream("ATCCutIn", 0),
        ascCutIn = frp.stepper(ascCutIn$, false),
        ascStatus = frp.liftN(
            (cutIn, hasPower) => {
                if (hasPower) {
                    return cutIn ? 1 : 0;
                } else {
                    return -1;
                }
            },
            ascCutIn,
            masterKey
        ),
        setAscStatus$ = frp.compose(
            ascCutIn$,
            frp.merge<boolean, boolean>(masterKey$),
            frp.map(_ => frp.snapshot(ascStatus))
        ),
        asc$ = frp.hub<asc.AscState>()(asc.create(me, cabAspect, acknowledge, coastOrBrake, ascCutIn$, masterKey)),
        ascPenalty$ = frp.map((state: asc.AscState) => {
            switch (state.brakes) {
                case asc.AscBrake.Emergency:
                case asc.AscBrake.Penalty:
                    return true;
                default:
                    return false;
            }
        })(asc$);
    setAscStatus$(status => {
        me.rv.SetControlValue("ATCStatus", 0, status);
    });
    ascPenalty$(penalty => {
        me.rv.SetControlValue("PenaltyIndicator", 0, penalty ? 1 : 0);
        me.rv.SetControlValue("Overspeed", 0, penalty ? 1 : 0);
    });

    const acsesCutIn$ = createCutInStream("ACSESCutIn", 0),
        acsesCutIn = frp.stepper(acsesCutIn$, false),
        acsesStatus = frp.liftN(
            (cutIn, hasPower) => {
                if (hasPower) {
                    return cutIn ? 2 : 0;
                } else {
                    return -1;
                }
            },
            acsesCutIn,
            masterKey
        ),
        setAcsesStatus$ = frp.compose(
            acsesCutIn$,
            frp.merge<boolean, boolean>(masterKey$),
            frp.map(_ => frp.snapshot(acsesStatus))
        ),
        acses$ = frp.hub<acses.AcsesState>()(acses.create(me, acknowledge, coastOrBrake, acsesCutIn$, masterKey)),
        acsesPenalty$ = frp.map((state: acses.AcsesState) => {
            switch (state.brakes) {
                case acses.AcsesBrake.Penalty:
                case acses.AcsesBrake.PositiveStop:
                    return true;
                default:
                    return false;
            }
        })(acses$),
        acsesOverspeed$ = frp.map((state: acses.AcsesState) => state.overspeed)(acses$),
        acsesStop$ = frp.map((state: acses.AcsesState) => state.brakes === acses.AcsesBrake.PositiveStop)(acses$),
        trackSpeedMps$ = frp.map((state: acses.AcsesState) => state.trackSpeedMps)(acses$);
    setAcsesStatus$(status => {
        me.rv.SetControlValue("ACSESStatus", 0, status);
    });
    acsesPenalty$(penalty => {
        me.rv.SetControlValue("ACSESPenalty", 0, penalty ? 1 : 0);
    });
    acsesOverspeed$(overspeed => {
        me.rv.SetControlValue("ACSESOverspeed", 0, overspeed ? 1 : 0);
    });
    acsesStop$(stop => {
        me.rv.SetControlValue("ACSESStop", 0, stop ? 1 : 0);
    });
    trackSpeedMps$(speedMps => {
        let h, t, u;
        if (speedMps === undefined) {
            [h, t, u] = [-1, -1, -1];
        } else {
            [[h, t, u]] = m.digits(Math.round(speedMps * c.mps.toMph), 3);
        }
        me.rv.SetControlValue("TrackSpeedHundreds", 0, h);
        me.rv.SetControlValue("TrackSpeedTens", 0, t);
        me.rv.SetControlValue("TrackSpeedUnits", 0, u);
    });

    const isAscOrAcsesOverspeed = frp.liftN(
            (ascPenalty, acsesOverspeed) => ascPenalty || acsesOverspeed,
            frp.stepper(ascPenalty$, false),
            frp.stepper(acsesOverspeed$, false)
        ),
        isAscOrAcsesOverspeed$ = frp.map(_ => frp.snapshot(isAscOrAcsesOverspeed))(me.createUpdateStream());
    isAscOrAcsesOverspeed$(overspeed => {
        me.rv.SetControlValue("ATCAlarm", 0, overspeed ? 1 : 0);
    });

    const isAnyAlarm = frp.liftN(
            (aleAlarm, ascPenalty, acsesOverspeed) => aleAlarm || ascPenalty || acsesOverspeed,
            frp.stepper(aleAlarm$, false),
            frp.stepper(ascPenalty$, false),
            frp.stepper(acsesOverspeed$, false)
        ),
        isAnyAlarm$ = frp.map(_ => frp.snapshot(isAnyAlarm))(me.createUpdateStream());
    isAnyAlarm$(alarm => {
        me.rv.SetControlValue("AWSWarnCount", 0, alarm ? 1 : 0);
    });

    // Set up throttle, reverser, dynamic brake, and air brake wiring.
    const airBrakeChargeThreshold = 0.37, // 90 psi BP
        aleBrake$ = frp.map((state: ale.AlerterState) => state.brakes)(ale$),
        ascBrake$ = frp.map((state: asc.AscState) => state.brakes)(asc$),
        acsesBrake$ = frp.map((state: acses.AcsesState) => state.brakes)(acses$),
        speedoMph$ = me.createGetCvStream("SpeedometerMPH", 0),
        speedoMph = frp.stepper(speedoMph$, 0),
        // Emergency brake push button with the backspace key, HUD, or pull cord.
        emergencyPullCord$ = frp.compose(
            me.createOnCvChangeStreamFor("VirtualEmergencyBrake", 0),
            frp.filter((cv: number) => cv >= 1),
            frp.map((_): BrakeEvent => BrakeType.Emergency)
        ),
        // Easy autostart with the startup control.
        startupCommand$ = me.createOnCvChangeStreamFor("VirtualStartup", 0),
        startupOn$ = frp.compose(
            startupCommand$,
            frp.filter((cv: number) => cv >= 1),
            frp.map((_): BrakeEvent => BrakeType.Autostart)
        ),
        startupOff$ = frp.filter((cv: number) => cv <= -1)(startupCommand$),
        brakeCommand = frp.liftN(
            (mc, aleBrake, ascBrake, acsesBrake): BrakeCommand => {
                if (ascBrake === asc.AscBrake.Emergency || mc === ControllerRegion.EmergencyBrake) {
                    return BrakeType.Emergency;
                } else if (
                    aleBrake === ale.AlerterBrake.Penalty ||
                    ascBrake === asc.AscBrake.Penalty ||
                    acsesBrake === acses.AcsesBrake.Penalty ||
                    acsesBrake === acses.AcsesBrake.PositiveStop
                ) {
                    return [BrakeType.Service, 1];
                } else if (mc === ControllerRegion.Coast || mc[0] === ControllerRegion.Power) {
                    return BrakeType.None;
                } else {
                    return [BrakeType.Service, mc[1]];
                }
            },
            masterController,
            frp.stepper(aleBrake$, ale.AlerterBrake.None),
            frp.stepper(ascBrake$, asc.AscBrake.None),
            frp.stepper(acsesBrake$, acses.AcsesBrake.None)
        ),
        brakesCanCharge = frp.liftN(
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
        ),
        chargeBrakes$ = frp.compose(
            me.createUpdateStream(),
            forPlayerEngine<number>(),
            fsm(0),
            frp.map(([from, to]) => {
                const chargePerSecond = 0.063; // 10 seconds to recharge to service braking
                return frp.snapshot(brakesCanCharge) ? chargePerSecond * (to - from) : 0;
            }),
            frp.filter(charge => charge > 0),
            frp.map((charge): BrakeEvent => [BrakeType.Charge, charge])
        ),
        brakeCommandAndEvents$ = frp.compose(
            me.createUpdateStream(),
            forPlayerEngine<number>(),
            frp.map(_ => frp.snapshot(brakeCommand)),
            frp.merge(emergencyPullCord$),
            frp.merge(startupOn$),
            frp.merge(chargeBrakes$),
            frp.hub()
        ),
        emergencyBrakeCanRelease = frp.liftN(
            (speedMph, bpPsi) => speedMph < c.stopSpeed && bpPsi <= 0,
            speedoMph,
            brakePipePsi
        ),
        emergencyBrake$ = frp.compose(
            brakeCommandAndEvents$,
            frp.fold<boolean, BrakeCommand | BrakeEvent>((accum, command) => {
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
        ),
        emergencyBrake = frp.stepper(emergencyBrake$, false),
        throttleCommand = frp.liftN(
            (mc, emergencyBrake) => {
                if (emergencyBrake) {
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
            emergencyBrake
        ),
        throttle$ = frp.compose(
            me.createUpdateStream(),
            forPlayerEngine<number>(),
            frp.map(_ => frp.snapshot(throttleCommand))
        ),
        // Blend dynamic and air braking.
        nMultipleUnits = () => Math.round(me.rv.GetConsistLength() / (85.5 * c.ft.toM)),
        dynamicBrake$ = frp.compose(
            me.createUpdateStream(),
            forPlayerEngine<number>(),
            fsm(0),
            frp.map(([from, to]): [dt: number, target: number] => {
                const brakes = frp.snapshot(brakeCommand);
                let target;
                switch (brakes) {
                    case BrakeType.None:
                    case BrakeType.Emergency:
                    case BrakeType.Autostart:
                        target = 0;
                        break;
                    default:
                        target = ((1 - 0.25) / (1 - 0)) * (brakes[1] - 1) + 1;
                        break;
                }
                return [to - from, target];
            }),
            // Simulate an exponential lag time for the dynamics to kick in.
            frp.fold<number, [dt: number, target: number]>((accum, input) => {
                const [dt, target] = input,
                    maxChangePerS = ((1 - 0.25) / (1 - 0)) * (accum - 0) + 0.25;
                return target <= accum ? target : Math.min(accum + maxChangePerS * dt, target);
            }, 0),
            // Physics are calibrated for a 12-car train.
            frp.map((v: number) => (v * frp.snapshot(nMultipleUnits)) / 12)
        ),
        airBrake$ = frp.compose(
            brakeCommandAndEvents$,
            frp.fold<number, BrakeCommand | BrakeEvent>((accum, brakes) => {
                if (brakes === BrakeType.Emergency) {
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
                        return airBrakeServiceRange(frp.snapshot(speedoMph) * c.mps.toMph, brakes[1]);
                    } else {
                        return accum;
                    }
                }
            }, 1),
            frp.hub()
        ),
        startupState$ = frp.compose(
            airBrake$,
            frp.map((applied: number) => applied <= airBrakeChargeThreshold),
            fsm(false)
        );
    throttle$(t => me.rv.SetControlValue("Regulator", 0, t));
    reverser$(r => {
        let cv;
        switch (r) {
            case Reverser.Reverse:
                cv = -1;
                break;
            case Reverser.Neutral:
            case Reverser.KeyOut:
            default:
                cv = 0;
                break;
            case Reverser.Forward:
                cv = 1;
                break;
        }
        me.rv.SetControlValue("Reverser", 0, cv);
    });
    airBrake$(a => {
        me.rv.SetControlValue("TrainBrakeControl", 0, a);
    });
    dynamicBrake$(d => {
        me.rv.SetControlValue("DynamicBrake", 0, d);
    });
    emergencyPullCord$(_ => {
        me.rv.SetControlValue("VirtualEmergencyBrake", 0, 0); // Reset the pull cord if tripped.
    });
    startupState$(([from, to]) => {
        if (!from && to) {
            me.rv.SetControlValue("VirtualStartup", 0, 1);
        } else if (from && !to) {
            me.rv.SetControlValue("VirtualStartup", 0, -1);
        }
    });
    startupOn$(_ => {
        me.rv.SetControlValue("MasterKey", 0, 1);
        me.rv.SetControlValue("UserVirtualReverser", 0, 1);
        me.rv.SetControlValue("ThrottleAndBrake", 0, -0.9);
    });
    startupOff$(_ => {
        me.rv.SetControlValue("MasterKey", 0, 0);
        me.rv.SetControlValue("UserVirtualReverser", 0, 3);
        me.rv.SetControlValue("ThrottleAndBrake", 0, -1);
    });

    // Set indicators on the driving display.
    const speedoMphDigits$ = frp.compose(speedoMph$, forPlayerEngine<number>(), threeDigitDisplay),
        brakePipePsiDigits$ = frp.compose(brakePipePsi$, forPlayerEngine<number>(), threeDigitDisplay),
        brakeCylinderPsiDigits$ = frp.compose(
            me.createGetCvStream("TrainBrakeCylinderPressurePSI", 0),
            forPlayerEngine<number>(),
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

    // Interior lights.
    const cabLight$ = frp.map((v: number) => v > 0.5)(me.createOnCvChangeStreamFor("Cablight", 0)),
        cabLight = new rw.Light("Cablight");
    cabLight$(on => cabLight.Activate(on));
    cabLight.Activate(false);

    const passLight$ = frp.map((vc: VehicleCamera) => vc === VehicleCamera.Carriage)(me.createCameraStream()),
        passLight = new rw.Light("RoomLight_PassView");
    passLight$(on => passLight.Activate(on));
    passLight.Activate(false);

    // Exterior lights.
    const brakeLight = frp.liftN(
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
        ),
        brakeLight$ = frp.map(_ => frp.snapshot(brakeLight))(me.createUpdateStream());
    brakeLight$(status => {
        me.rv.ActivateNode("SL_green", status === BrakeLight.Green);
        me.rv.ActivateNode("SL_yellow", status === BrakeLight.Amber);
    });
    me.rv.ActivateNode("SL_blue", false);

    const isTrueStopped = () => frp.snapshot(trueSpeedMps) < c.stopSpeed,
        leftDoorOpen = frp.liftN(
            (authority, stopped, playerDoor) => (authority === VehicleAuthority.IsPlayer ? playerDoor : stopped),
            authority,
            isTrueStopped,
            () => (me.rv.GetControlValue("DoorsOpenCloseLeft", 0) as number) > 0.5
        ),
        leftDoorOpen$ = frp.map(_ => frp.snapshot(leftDoorOpen))(me.createUpdateStream()),
        rightDoorOpen = frp.liftN(
            (authority, stopped, playerDoor) => (authority === VehicleAuthority.IsPlayer ? playerDoor : stopped),
            authority,
            isTrueStopped,
            () => (me.rv.GetControlValue("DoorsOpenCloseRight", 0) as number) > 0.5
        ),
        rightDoorOpen$ = frp.map(_ => frp.snapshot(rightDoorOpen))(me.createUpdateStream());
    leftDoorOpen$(open => {
        me.rv.ActivateNode("SL_doors_L", open);
    });
    rightDoorOpen$(open => {
        me.rv.ActivateNode("SL_doors_R", open);
    });

    // Process OnControlValueChange events.
    const onCvChange$ = me.createOnCvChangeStream();
    onCvChange$(([name, index, value]) => me.rv.SetControlValue(name, index, value));

    // Enable updates.
    me.activateUpdatesEveryFrame(true);
});
me.setup();

function threeDigitDisplay(eventStream: frp.Stream<number>) {
    return frp.compose(
        eventStream,
        frp.map((n: number) => Math.round(Math.abs(n))),
        frp.map(n => m.digits(n, 3))
    );
}

function airBrakeServiceRange(speedMps: number, application: number) {
    const aSpeedMps = Math.abs(speedMps),
        transitionMph: [start: number, end: number] = [1.341, 3.576], // from 3 to 8 mph
        minService = 0.048, // 13 psi BC
        maxService = 0.137, // 43 psi BC
        floor = 0.035; // 8 psi BC
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
