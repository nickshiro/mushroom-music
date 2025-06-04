export const MediaEnum = {
	YOUTUBE: 0,
	SPOTIFY: 1,
} as const;

export type MediaEnum = (typeof MediaEnum)[keyof typeof MediaEnum];

export type TrackType = {
	type: MediaEnum;
	url: string;
	title: string;
	thumbnail: string;
	duration: number;
};
