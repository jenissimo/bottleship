/**
 * OpenAL 3D diagnostics — the half of an AL source `openalSources` cannot show.
 *
 * `openalSources` reports the queue accounting an app polls. None of that says where the
 * app put the sound, and a positional bug is silent in every one of those numbers: the
 * cursors advance, the queue retires, and the game is simply quieter (or panned wrong)
 * than it should be. `openalSpatial` reports the model itself, and — through the SAME
 * `spatialize()` the AudioWorklet runs — the stereo gains and pitch ratio the mixer is
 * deriving from it right now. Two samples either side of a movement are what turn
 * "positioning works" into a measurement.
 */

import type { HarnessService } from "../service";
import { getModule } from "../serialize";
import {
    spatialize, makeSpatialResult, type SpatialParams,
} from "../../../audio/spatializer";
import {
    distanceModelToMixer, type ALListenerState, type ALContextSpatial,
} from "../../modules/openal/spatial";

interface ALSpatialSnapshot {
    listener: ALListenerState;
    global: ALContextSpatial;
    listenerPublished: boolean;
    sources: Array<{
        id: number;
        spatialized: boolean;
        relative: boolean;
        pos: [number, number, number];
        vel: [number, number, number];
        dir: [number, number, number];
        gain: number; minGain: number; maxGain: number;
        refDistance: number; maxDistance: number; rolloff: number;
        cone: [number, number, number];
    }>;
}

export function registerOpenAlCommands(svc: HarnessService): void {
    svc.register("openalSpatial", () => {
        const al = getModule("wrap_oal") as unknown as
            { openalSpatial?: () => ALSpatialSnapshot } | undefined;
        if (!al?.openalSpatial) return { error: "no wrap_oal module" };
        const snap = al.openalSpatial();

        const out = makeSpatialResult();
        const p: SpatialParams = {
            lPosX: snap.listener.posX, lPosY: snap.listener.posY, lPosZ: snap.listener.posZ,
            lVelX: snap.listener.velX, lVelY: snap.listener.velY, lVelZ: snap.listener.velZ,
            lAtX: snap.listener.atX, lAtY: snap.listener.atY, lAtZ: snap.listener.atZ,
            lUpX: snap.listener.upX, lUpY: snap.listener.upY, lUpZ: snap.listener.upZ,
            listenerGain: snap.listener.gain,
            distanceFactor: 1,
            dopplerFactor: snap.global.dopplerFactor,
            speedOfSound: snap.global.speedOfSound,
            distanceModel: distanceModelToMixer(snap.global.distanceModel),
            rightHanded: true,
            sPosX: 0, sPosY: 0, sPosZ: 0, sVelX: 0, sVelY: 0, sVelZ: 0,
            refDistance: 1, maxDistance: 1, rolloff: 1,
            coneInner: 360, coneOuter: 360, coneOuterGain: 0,
            dirX: 0, dirY: 0, dirZ: 0,
            sourceGain: 1, minGain: 0, maxGain: 1,
            relative: false,
        };

        const sources = snap.sources.map((s) => {
            if (!s.spatialized) {
                return { ...s, mix: null as null | Record<string, number>, distance: null };
            }
            p.sPosX = s.pos[0]; p.sPosY = s.pos[1]; p.sPosZ = s.pos[2];
            p.sVelX = s.vel[0]; p.sVelY = s.vel[1]; p.sVelZ = s.vel[2];
            p.dirX = s.dir[0]; p.dirY = s.dir[1]; p.dirZ = s.dir[2];
            p.refDistance = s.refDistance; p.maxDistance = s.maxDistance; p.rolloff = s.rolloff;
            p.coneInner = s.cone[0]; p.coneOuter = s.cone[1]; p.coneOuterGain = s.cone[2];
            p.sourceGain = s.gain; p.minGain = s.minGain; p.maxGain = s.maxGain;
            p.relative = s.relative;
            spatialize(p, out);
            const dx = s.relative ? s.pos[0] : s.pos[0] - snap.listener.posX;
            const dy = s.relative ? s.pos[1] : s.pos[1] - snap.listener.posY;
            const dz = s.relative ? s.pos[2] : s.pos[2] - snap.listener.posZ;
            return {
                ...s,
                distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
                mix: {
                    left: out.leftGain,
                    right: out.rightGain,
                    total: Math.sqrt(out.leftGain * out.leftGain + out.rightGain * out.rightGain),
                    // >0 = right of the listener, <0 = left. The sign is the claim a
                    // positional bug gets wrong while every level stays plausible.
                    balance: out.rightGain - out.leftGain,
                    rateMul: out.rateMul,
                },
            };
        });

        return { listener: snap.listener, global: snap.global, listenerPublished: snap.listenerPublished, sources };
    });
}
