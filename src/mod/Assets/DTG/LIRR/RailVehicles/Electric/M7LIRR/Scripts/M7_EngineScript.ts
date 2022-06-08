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
enum BrakeType {
    None,
    Service,
    Emergency,
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
            me.createOnCvChangeStreamFor("MasterKey", 0),
            frp.map((cv: number) => cv > 0.5)
        ),
        masterKey = frp.stepper(masterKey$, false),
        masterController$ = frp.compose(
            me.createOnCvChangeStreamFor("ThrottleAndBrake", 0),
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
            me.createOnCvChangeStreamFor("UserVirtualReverser", 0),
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
    lockMasterKeyOn$(_ => me.rv.SetControlValue("MasterKey", 0, 1));
    lockReverserKeyOut$(_ => me.rv.SetControlValue("UserVirtualReverser", 0, 3));
    lockReverserOutOfEmergency$(cv => me.rv.SetControlValue("UserVirtualReverser", 0, Math.min(cv, 2)));
    lockMasterControllerKeyOut(_ => me.rv.SetControlValue("ThrottleAndBrake", 0, -1));

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
    const aleBrake$ = frp.map((state: ale.AlerterState) => state.brakes)(ale$),
        ascBrake$ = frp.map((state: asc.AscState) => state.brakes)(asc$),
        acsesBrake$ = frp.map((state: acses.AcsesState) => state.brakes)(acses$),
        speedoMph$ = me.createGetCvStream("SpeedometerMPH", 0),
        speedoMph = frp.stepper(speedoMph$, 0),
        emergencyPullCord$ = frp.compose(
            me.createOnCvChangeStreamFor("VirtualEmergencyBrake", 0),
            frp.filter((cv: number) => cv >= 1),
            frp.map((_): BrakeCommand => BrakeType.Emergency)
        ),
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
        brakeCommandWithLatch$ = frp.compose(
            me.createUpdateStream(),
            frp.map((_: number) => frp.snapshot(brakeCommand)),
            frp.merge(emergencyPullCord$),
            frp.fold<BrakeCommand, BrakeCommand>((accum, command) => {
                const isStopped = Math.abs(frp.snapshot(speedoMph)) < c.stopSpeed,
                    brakePipeDischarged = frp.snapshot(brakePipePsi) <= 0;
                if (command === BrakeType.Emergency) {
                    return BrakeType.Emergency;
                } else if (accum === BrakeType.Emergency && !(isStopped && brakePipeDischarged)) {
                    return BrakeType.Emergency;
                } else {
                    return command;
                }
            }, BrakeType.None)
        ),
        brakeCommandWithLatch = frp.stepper(brakeCommandWithLatch$, BrakeType.None),
        throttleCommand = frp.liftN(
            (mc, brakes) => {
                if (brakes !== BrakeType.None) {
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
            brakeCommandWithLatch
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
                const brakes = frp.snapshot(brakeCommandWithLatch);
                let target;
                if (brakes === BrakeType.None || brakes === BrakeType.Emergency) {
                    target = 0;
                } else {
                    target = ((1 - 0.25) / (1 - 0)) * (brakes[1] - 1) + 1;
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
        airBrakeCommand = frp.liftN(
            (brakes, speedMph) => {
                if (brakes === BrakeType.Emergency) {
                    return 1;
                } else if (brakes === BrakeType.None) {
                    return 0;
                } else {
                    const minService = 0.048, // 13 psi BC
                        maxService = 0.137, // 43 psi BC
                        floor = 0.035, // 8 psi BC
                        proportion = blendedAirBrake(speedMph * c.mph.toMps);
                    return Math.max(
                        (((maxService - minService) / (1 - 0)) * (brakes[1] - 0) + minService) * proportion,
                        floor
                    );
                }
            },
            brakeCommandWithLatch,
            speedoMph
        ),
        // Require the air brake to be charged after being placed in emergency.
        brakesCharging = frp.liftN(
            (brakes, isCharging) => {
                return (
                    brakes !== BrakeType.Emergency && brakes !== BrakeType.None && brakes[1] >= 1 - 0.05 && isCharging
                );
            },
            brakeCommandWithLatch,
            () => (me.rv.GetControlValue("Charging", 0) as number) > 0.5
        ),
        airBrake$ = frp.compose(
            me.createUpdateStream(),
            forPlayerEngine<number>(),
            fsm(0),
            frp.map(([from, to]) => {
                const chargePerSecond = 0.063; // 10 seconds to recharge to service braking
                return frp.snapshot(brakesCharging) ? chargePerSecond * (to - from) : 0;
            }),
            frp.fold<number, number>((accum, charge) => {
                const threshold = 0.37, // 90 psi BP
                    applied = frp.snapshot(airBrakeCommand);
                if (applied >= 1) {
                    return 1;
                } else if (accum > threshold) {
                    return accum - charge;
                } else {
                    return applied;
                }
            }, 0)
        );
    throttle$(t => me.rv.SetControlValue("Regulator", 0, t));
    reverser$(r => {
        let cv: number;
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
    airBrake$(a => me.rv.SetControlValue("TrainBrakeControl", 0, a));
    dynamicBrake$(d => me.rv.SetControlValue("DynamicBrake", 0, d));
    emergencyPullCord$(_ => me.rv.SetControlValue("VirtualEmergencyBrake", 0, 0)); // Reset the pull cord if tripped.

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
    brakeCommandWithLatch$(brakes => {
        me.rv.SetControlValue("EmergencyBrakesIndicator", 0, brakes === BrakeType.Emergency ? 1 : 0);
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
    leftDoorOpen$(open => me.rv.ActivateNode("SL_doors_L", open));
    rightDoorOpen$(open => me.rv.ActivateNode("SL_doors_R", open));

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

function blendedAirBrake(speedMps: number) {
    const transitionMph: [start: number, end: number] = [1.341, 3.576], // from 3 to 8 mph
        aSpeedMps = Math.abs(speedMps);
    if (aSpeedMps < transitionMph[0]) {
        return 1;
    } else if (aSpeedMps < transitionMph[1]) {
        return (-1 / (transitionMph[1] - transitionMph[0])) * (aSpeedMps - transitionMph[1]);
    } else {
        return 0;
    }
}
