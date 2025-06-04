import type {
	ValkeyClientOptions,
	ValkeyClientType,
} from "@valkey/client/dist/lib/client";
import { createClient } from "@valkey/client";
import type {
	ValkeyFunctions,
	ValkeyModules,
	ValkeyScripts,
} from "@valkey/client/dist/lib/commands";
import type { TrackType } from "./types/track";
import type { VoiceBasedChannel } from "discord.js";
import type { AudioPlayer, VoiceConnection } from "@discordjs/voice";

export class PlaylistStorage {
	private readonly _maxPreviousLength = 10;
	private readonly _maxQueueLength = 90;

	private _client: ValkeyClientType<
		ValkeyModules,
		ValkeyFunctions,
		ValkeyScripts
	>;

	public constructor(options: ValkeyClientOptions) {
		this._client = createClient(options);
		this._client
			.on("error", (err) => console.log("Valkey client error:", err))
			.connect();
	}

	public disconnect(): Promise<void> {
		return this._client.disconnect();
	}

	private current(channel: VoiceBasedChannel): string {
		return `${channel}:current`;
	}

	private queue(channel: VoiceBasedChannel): string {
		return `${channel}:queue`;
	}

	public async setCurrent(
		channel: VoiceBasedChannel,
		index: number,
	): Promise<void> {
		const key = this.current(channel);
		const queueKey = this.queue(channel);

		await this._client.set(key, String(index));

		if (index > this._maxPreviousLength) {
			const start = index - this._maxPreviousLength;
			await this._client.lTrim(queueKey, start, -1);
			await this._client.set(key, String(this._maxPreviousLength));
		}
	}

	public async getCurrentIndex(
		channel: VoiceBasedChannel,
	): Promise<number | null> {
		const value = await this._client.get(this.current(channel));
		if (value === null) return null;
		const num = Number(value);
		return Number.isNaN(num) ? null : num;
	}

	public async getCurrentTrack(
		channel: VoiceBasedChannel,
	): Promise<TrackType | null> {
		const index = await this.getCurrentIndex(channel);
		if (index === null) {
			return null;
		}
		return await this.getTrackByIndex(channel, index);
	}

	public async addTracks(
		channel: VoiceBasedChannel,
		tracks: TrackType[],
	): Promise<number> {
		const queueLength = await this._client.lLen(this.queue(channel));
		const maxLength = this._maxPreviousLength + this._maxQueueLength;

		if (tracks.length > maxLength - queueLength) {
			const allowToAdd = maxLength - queueLength;

			if (allowToAdd < 1) {
				return 0;
			}

			const value = tracks.map((t) => JSON.stringify(t)).slice(0, allowToAdd);
			await this._client.rPush(this.queue(channel), value);
			return value.length;
		}

		const value = tracks.map((t) => JSON.stringify(t));
		await this._client.rPush(this.queue(channel), value);
		return value.length;
	}

	public async getTrackByIndex(
		channel: VoiceBasedChannel,
		index: number,
	): Promise<TrackType | null> {
		const raw = await this._client.lIndex(this.queue(channel), index);

		if (!raw) {
			return null;
		}

		return JSON.parse(raw);
	}

	public async getQueue(channel: VoiceBasedChannel): Promise<TrackType[]> {
		const raw = await this._client.lRange(this.queue(channel), 0, -1);
		return raw.map((item) => JSON.parse(item));
	}

	public async getQueueLength(channel: VoiceBasedChannel): Promise<number> {
		return this._client.lLen(this.queue(channel));
	}

	public async clear(channel: VoiceBasedChannel): Promise<void> {
		await this._client.del(this.queue(channel));
		await this._client.del(this.current(channel));
	}
}

export class PlayerStorage {
	private _players: Map<VoiceBasedChannel, AudioPlayer>;

	public constructor() {
		this._players = new Map();
	}

	public set(channelId: VoiceBasedChannel, player: AudioPlayer): void {
		this._players.set(channelId, player);
	}

	public get(channelId: VoiceBasedChannel): AudioPlayer | undefined {
		return this._players.get(channelId);
	}

	public delete(channelId: VoiceBasedChannel): void {
		this._players.delete(channelId);
	}
}

export class ConnectionStorage {
	private _connections: Map<VoiceBasedChannel, VoiceConnection>;

	public constructor() {
		this._connections = new Map();
	}

	public set(channelId: VoiceBasedChannel, connection: VoiceConnection): void {
		this._connections.set(channelId, connection);
	}

	public get(channelId: VoiceBasedChannel): VoiceConnection | undefined {
		return this._connections.get(channelId);
	}

	public delete(channelId: VoiceBasedChannel): void {
		this._connections.delete(channelId);
	}
}
