/**
 * The names the guest machine answers to. One definition, because a title that reads the
 * machine name through two different APIs (GetComputerName and NetWkstaGetInfo is the
 * common pair, in licence/fingerprint code) treats a disagreement as a tampered machine.
 */

export const GUEST_COMPUTER_NAME = "BOTTLESHIP";
export const GUEST_WORKGROUP_NAME = "WORKGROUP";
