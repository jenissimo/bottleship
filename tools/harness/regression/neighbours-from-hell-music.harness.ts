/**
 * Neighbours from Hell (Buka): padded MP3 assets must reach the host decoder.
 * Run with WGB pointing to a locally imported bundle; no game data is included.
 *
 * The title's jingle starts with a zero-filled MPEG frame. Magic-only dispatch
 * used to leave it pending forever even though its file callbacks read it fully.
 * This checks decoded format, a moving guest cursor and host decoder progress.
 */
import { harness } from "../../harness";

const WGB = process.env.WGB;
if (!WGB) throw new Error("Set WGB to the imported Neighbours from Hell (Buka) bundle");

const boot = await harness().reload().openWgb(WGB, { reload: false })
    .watchFrames(true).tickFrames(300)
    .clickHold(320, 240, 200).tickFrames(120)
    .clickHold(410, 315, 200).tickFrames(120)
    .clickHold(744, 555, 200).tickFrames(120)
    .call("mssStreams").call("mssAudio", { sampleMs: 1000 })
    .call("audioSignal").call("report").run();

if (!boot.ok) throw new Error(`Tutorial entry failed: ${boot.error}`);
const streams = boot.named.mssStreams as any;
const jingle = streams?.streams?.find((s: any) => /jingle_levelstart\.mp3$/i.test(s.filename));
if (!jingle || jingle.format !== "mp3" || jingle.pendingStart || !jingle.isPlaying) {
    throw new Error(`Padded jingle was not started: ${JSON.stringify(jingle)}`);
}
if (jingle.fileProbe?.dataStart <= 0 || jingle.sampleRate !== 44100) {
    throw new Error("The test did not exercise a padded 44.1 kHz MPEG stream");
}
const census = boot.named.mssAudio as any;
const moving = census?.streams?.find((s: any) => s.id === jingle.id);
if (!(moving?.deltaPublishedMs > 0)) throw new Error("Jingle cursor did not advance");
const signal = boot.named.audioSignal as any;
const host = signal?.host?.[jingle.id];
if (!host?.started || !(host.positions > 1) || host.error) {
    throw new Error(`Host decoder did not consume the jingle: ${JSON.stringify(host)}`);
}
const report = boot.named.report as any;
if (report?.crash) throw new Error(`Guest crashed: ${JSON.stringify(report.crash)}`);
console.log(`OK — padded MPEG starts at ${jingle.fileProbe.dataStart}, cursor advances, host decoder consumes audio`);
