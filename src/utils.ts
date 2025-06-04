export function formatDuration(seconds: number): string {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
		return "Unknown";
	}

	const days = Math.floor(seconds / 86400);
	const hrs = Math.floor((seconds % 86400) / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);

	const paddedHrs = hrs.toString().padStart(2, "0");
	const paddedMins = mins.toString().padStart(2, "0");
	const paddedSecs = secs.toString().padStart(2, "0");

	if (days > 0) {
		return `${days}d ${paddedHrs}:${paddedMins}:${paddedSecs}`;
	}
	if (hrs > 0) {
		return `${paddedHrs}:${paddedMins}:${paddedSecs}`;
	}
	return `${paddedMins}:${paddedSecs}`;
}
