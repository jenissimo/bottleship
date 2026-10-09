/**
 * The volume label D: should report for a bundle packed from disc images: the label of the
 * disc D: is redirected to (manifest emulator.cdPath), or none when cdPath is not a disc's
 * root. A disc packs at C:\ itself, or at C:\discN with --disc-dirs. Labels are each disc's
 * readVolumeLabel, passed through as read.
 */
export function discLabelForCdPath(cdPath: string, volumeLabels: readonly string[], discDirs: boolean): string | undefined {
    const path = cdPath.trim().replace(/[\\/]+$/, "").toUpperCase();
    let index: number;
    if (discDirs) {
        const m = /^C:[\\/]DISC(\d+)$/.exec(path);
        if (!m) return undefined;
        index = Number(m[1]) - 1;
    } else {
        if (path !== "C:") return undefined;
        index = 0;
    }
    return volumeLabels[index] || undefined;
}
