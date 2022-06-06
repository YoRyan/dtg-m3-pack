/** @noSelfInFile */

import * as acses from "../../../../../../../../lib/acses";
import * as ale from "../../../../../../../../lib/alerter";
import * as asc from "../../../../../../../../lib/asc";
import * as cs from "../../../../../../../../lib/cabsignals";
import * as c from "../../../../../../../../lib/constants";
import * as frp from "../../../../../../../../lib/frp";
import { FrpEngine } from "../../../../../../../../lib/frp-engine";
import { debug, fsm, rejectUndefined } from "../../../../../../../../lib/frp-extra";
import { VehicleCamera } from "../../../../../../../../lib/frp-vehicle";
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

type BrakeCommand = BrakeType.None | [BrakeType.Service, number] | BrakeType.Emergency;

enum BrakeType {
    None,
    Service,
    Emergency,
}

const me = new FrpEngine(() => {
    function forPlayerEngine<T>(): (eventStream: frp.Stream<T>) => frp.Stream<T> {
        return frp.filter((_: T) => me.eng.GetIsEngineWithKey());
    }

    const masterController$ = frp.compose(
            me.createOnCvChangeStreamFor("ThrottleAndBrake", 0),
            frp.map(readMasterController)
        ),
        masterController = frp.stepper(
            masterController$,
            readMasterController(me.rv.GetControlValue("ThrottleAndBrake", 0) as number)
        ),
        acknowledge = () => (me.rv.GetControlValue("AWSReset", 0) as number) > 0.5,
        coastOrBrake = () => {
            const mc = frp.snapshot(masterController);
            return (
                mc === ControllerRegion.EmergencyBrake ||
                mc === ControllerRegion.Coast ||
                mc[0] === ControllerRegion.ServiceBrake
            );
        };

    // Configure and initialize safety systems.
    const cabSignal$ = frp.compose(
            me.createOnCustomSignalMessageStream(),
            frp.map((msg: string) => cs.toPulseCode(msg)),
            rejectUndefined(),
            frp.map(pc => cs.toLirrAspect(pc))
        ),
        cabAspect = frp.stepper(cabSignal$, cs.LirrAspect.Speed15);
    cabSignal$(_ => showCabSignal(frp.snapshot(cabAspect)));
    showCabSignal(frp.snapshot(cabAspect)); // Show the initialized cab aspect.

    const aleCutIn$ = cutInControl(me.createOnCvChangeStreamFor("ALECutIn", 0)),
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
        ale$ = frp.hub<ale.AlerterState>()(ale.create(me, aleInput$, aleCutIn$)),
        aleAlarm$ = frp.map((state: ale.AlerterState) => state.alarm)(ale$);
    aleAlarm$(alarm => {
        me.rv.SetControlValue("AlerterIndicator", 0, alarm ? 1 : 0);
        me.rv.SetControlValue("ALEAlarm", 0, alarm ? 1 : 0);
    });

    const ascCutIn$ = cutInControl(me.createOnCvChangeStreamFor("ATCCutIn", 0)),
        asc$ = frp.hub<asc.AscState>()(asc.create(me, cabAspect, acknowledge, coastOrBrake, ascCutIn$)),
        ascPenalty$ = frp.map((state: asc.AscState) => {
            switch (state.brakes) {
                case asc.AscBrake.Emergency:
                case asc.AscBrake.Penalty:
                    return true;
                default:
                    return false;
            }
        })(asc$);
    ascPenalty$(penalty => {
        me.rv.SetControlValue("PenaltyIndicator", 0, penalty ? 1 : 0);
        me.rv.SetControlValue("Overspeed", 0, penalty ? 1 : 0);
    });

    const acsesCutIn$ = cutInControl(me.createOnCvChangeStreamFor("ACSESCutIn", 0)),
        acses$ = frp.hub<acses.AcsesState>()(acses.create(me, acknowledge, coastOrBrake, acsesCutIn$)),
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
    acsesCutIn$(cutIn => {
        me.rv.SetControlValue("ACSESStatus", 0, cutIn ? 2 : 0);
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

    // Set up the throttle and brake wiring.
    const aleBrake$ = frp.map((state: ale.AlerterState) => state.brakes)(ale$),
        ascBrake$ = frp.map((state: asc.AscState) => state.brakes)(asc$),
        acsesBrake$ = frp.map((state: acses.AcsesState) => state.brakes)(acses$),
        speedoMph$ = me.createGetCvStream("SpeedometerMPH", 0),
        speedoMph = frp.stepper(speedoMph$, 0),
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
            frp.fold<BrakeCommand, BrakeCommand>((accum, command) => {
                const isStopped = Math.abs(frp.snapshot(speedoMph)) < c.stopSpeed;
                if (command === BrakeType.Emergency) {
                    return BrakeType.Emergency;
                } else if (accum === BrakeType.Emergency && !isStopped) {
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
    airBrake$(a => me.rv.SetControlValue("TrainBrakeControl", 0, a));
    dynamicBrake$(d => me.rv.SetControlValue("DynamicBrake", 0, d));

    // Set indicators on the driving display.
    const speedoMphDigits$ = frp.compose(speedoMph$, forPlayerEngine<number>(), threeDigitDisplay),
        brakePipePsiDigits$ = frp.compose(
            me.createGetCvStream("AirBrakePipePressurePSI", 0),
            forPlayerEngine<number>(),
            threeDigitDisplay
        ),
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

    // Interior lights.
    const cabLight$ = frp.map((v: number) => v > 0.5)(me.createOnCvChangeStreamFor("Cablight", 0)),
        cabLight = new rw.Light("Cablight");
    cabLight$(on => cabLight.Activate(on));
    cabLight.Activate(false);

    const passLight$ = frp.map((vc: VehicleCamera) => vc === VehicleCamera.Carriage)(me.createCameraStream()),
        passLight = new rw.Light("RoomLight_PassView");
    passLight$(on => passLight.Activate(on));
    passLight.Activate(false);

    // Process OnControlValueChange events.
    const onCvChange$ = me.createOnCvChangeStream();
    onCvChange$(([name, index, value]) => me.rv.SetControlValue(name, index, value));

    // Enable updates.
    me.activateUpdatesEveryFrame(true);
});
me.setup();

function readMasterController(cv: number): MasterController {
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
}

function threeDigitDisplay(eventStream: frp.Stream<number>) {
    return frp.compose(
        eventStream,
        frp.map((n: number) => Math.round(Math.abs(n))),
        frp.map(n => m.digits(n, 3))
    );
}

function cutInControl(eventStream: frp.Stream<number>) {
    return frp.compose(
        eventStream,
        frp.filter((v: number) => v === 0 || v === 1),
        frp.map(v => v === 1)
    );
}

function showCabSignal(aspect: cs.LirrAspect) {
    me.rv.SetControlValue(
        "SignalSpeedLimit",
        0,
        {
            [cs.LirrAspect.Speed15]: 15,
            [cs.LirrAspect.Speed30]: 30,
            [cs.LirrAspect.Speed40]: 40,
            [cs.LirrAspect.Speed60]: 60,
            [cs.LirrAspect.Speed70]: 70,
            [cs.LirrAspect.Speed80]: 80,
        }[aspect]
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
