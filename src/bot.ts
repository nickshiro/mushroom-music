import {
	ActivityType,
	Client,
	EmbedBuilder,
	GatewayIntentBits,
	SlashCommandBuilder,
} from "discord.js";
import type {
	CommandInteraction,
	GuildMember,
	VoiceBasedChannel,
} from "discord.js";
import { MediaEnum, type TrackType } from "./types/track";
import ytdl from "@distube/ytdl-core";
import ytpl from "@distube/ytpl";
import { youtube } from "scrape-youtube";
import { ConnectionStorage, PlayerStorage, PlaylistStorage } from "./storage";
import {
	AudioPlayerStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
	StreamType,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import { formatDuration } from "./utils";

function onlyVoiceChannel(
	_target: any,
	_propertyKey: string | symbol,
	descriptor: PropertyDescriptor,
) {
	const originalMethod = descriptor.value;

	descriptor.value = async function (
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	) {
		if (!channel) {
			await interaction.reply({
				embeds: [
					new EmbedBuilder().setDescription(
						"You need to be in a voice channel to use this command",
					),
				],
			});
			return;
		}
		return await originalMethod.apply(this, [interaction, channel]);
	};

	return descriptor;
}

export class Bot {
	private _client: Client;
	private _playlist_storage: PlaylistStorage;
	private _player_storage: PlayerStorage;
	private _connection_storage: ConnectionStorage;

	private readonly _commands = [
		new SlashCommandBuilder()
			.setName("add")
			.setDescription("Add a track or playlist to the queue")
			.addStringOption((option) =>
				option
					.setName("query")
					.setDescription("YouTube URL or search query")
					.setRequired(true),
			),

		new SlashCommandBuilder()
			.setName("pause")
			.setDescription("Pause the currently playing track"),

		new SlashCommandBuilder()
			.setName("resume")
			.setDescription("Resume the paused track"),

		new SlashCommandBuilder()
			.setName("next")
			.setDescription("Skip to the next track in the queue"),

		new SlashCommandBuilder()
			.setName("previous")
			.setDescription("Go back to the previous track"),

		new SlashCommandBuilder()
			.setName("jump")
			.setDescription("Jump to a specific track in the queue")
			.addNumberOption((option) =>
				option
					.setName("to")
					.setDescription("Track number to jump to")
					.setRequired(true),
			),

		new SlashCommandBuilder()
			.setName("queue")
			.setDescription("View the current queue"),

		new SlashCommandBuilder()
			.setName("current")
			.setDescription("Show the currently playing track"),

		new SlashCommandBuilder()
			.setName("leave")
			.setDescription("Disconnect the bot from the voice channel"),

		new SlashCommandBuilder()
			.setName("help")
			.setDescription("List all available bot commands"),
	];

	private async registerCommands(): Promise<void> {
		try {
			await this._client.application?.commands.set(this._commands);
			console.log("Slash commands registered successfully!");
		} catch (error) {
			console.error("Error registering slash commands:", error);
		}
	}

	private async getTracks(query: string): Promise<TrackType[]> {
		const youtubeVideoRegexp =
			/^((?:https?:)?\/\/)?((?:www|m)\.)?(youtube\.com|youtu\.be)\/((watch\?v=|embed\/|v\/)?)([\w-]{11})(?!.*[?&]list=)(\S*)?$/;
		const youtubePlaylistRegexp =
			/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com)\/(?:playlist\?list=|watch\?.*?[&?]list=)([a-zA-Z0-9_-]+)/;

		if (query.match(youtubeVideoRegexp)) {
			try {
				const info = await ytdl.getInfo(query);
				return [
					{
						type: MediaEnum.YOUTUBE,
						title: info.videoDetails.title,
						url: info.videoDetails.video_url,
						duration: Number.parseInt(info.videoDetails.lengthSeconds),
						thumbnail: info.videoDetails.thumbnails?.[0]?.url || "",
					},
				];
			} catch (err) {
				console.error("Youtube video info error", err);
			}
		}

		if (query.match(youtubePlaylistRegexp)) {
			try {
				const playlist = await ytpl(query);

				return playlist.items.map((item) => ({
					type: MediaEnum.YOUTUBE,
					title: item.title || "Unknown Title",
					url: item.url,
					duration: Number.parseInt(item.duration || "0"),
					thumbnail: item.thumbnail || "",
				}));
			} catch (err) {
				console.error("Youtube playlist error", err);
			}
		}
		try {
			const searchResults = await youtube.search(query, { type: "video" });

			if (!searchResults.videos || searchResults.videos.length === 0) {
				return [
					{
						type: MediaEnum.YOUTUBE,
						title:
							"Rick Astley - Never Gonna Give You Up (Official Music Video)",
						url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
						duration: 202000,
						thumbnail:
							"https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg?sqp=-oaymwEnCNAFEJQDSFryq4qpAxkIARUAAIhCGAHYAQHiAQoIGBACGAY4AUAB&rs=AOn4CLDd7bl4P7By8G8OG22vtHQSLfxASg",
					},
				];
			}

			const video = searchResults.videos[0];
			if (video) {
				return [
					{
						type: MediaEnum.YOUTUBE,
						title: video?.title || "Unknown Title",
						url: `https://www.youtube.com/watch?v=${video.id}`,
						duration: video?.duration || 0,
						thumbnail: video?.thumbnail || "",
					},
				];
			}
		} catch (err) {
			console.error("Search error", err);
		}
		return [];
	}

	private async clearStorage(channel: VoiceBasedChannel): Promise<void> {
		this._connection_storage.delete(channel);
		this._player_storage.delete(channel);
		await this._playlist_storage.clear(channel);
	}

	private async createConnection(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	): Promise<void> {
		const connection = joinVoiceChannel({
			channelId: channel.id,
			guildId: channel.guildId,
			adapterCreator: channel.guild.voiceAdapterCreator,
		});

		const player = createAudioPlayer();
		connection.subscribe(player);

		connection.on(VoiceConnectionStatus.Disconnected, async () => {
			try {
				await Promise.race([
					entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
					entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
				]);
			} catch {
				this.clearStorage(channel);
			}
		});

		player.on(AudioPlayerStatus.Idle, () => {
			this.playingNext(channel);
		});

		this._connection_storage.set(channel, connection);
		this._player_storage.set(channel, player);
	}

	private async playTrack(
		channel: VoiceBasedChannel,
		track: TrackType,
	): Promise<void> {
		try {
			const stream = ytdl(track.url, {
				filter: "audio",
				quality: "highestaudio",
				highWaterMark: 1 << 25,
			});

			const resource = createAudioResource(stream, {
				inputType: StreamType.Arbitrary,
				inlineVolume: true,
			});

			this._player_storage.get(channel)?.play(resource);
		} catch (err) {
			console.log(err);
		}
	}

	private async playPrevious(channel: VoiceBasedChannel): Promise<boolean> {
		const currentIndex = await this._playlist_storage.getCurrentIndex(channel);

		if (currentIndex === null || currentIndex < 1) {
			return false;
		}

		const previousTrack = await this._playlist_storage.getTrackByIndex(
			channel,
			currentIndex - 1,
		);

		if (previousTrack !== null) {
			this.playTrack(channel, previousTrack);
			this._playlist_storage.setCurrent(channel, currentIndex - 1);
			return true;
		}

		return false;
	}

	private async playingNext(channel: VoiceBasedChannel): Promise<boolean> {
		const currentIndex = await this._playlist_storage.getCurrentIndex(channel);
		const queueLength = await this._playlist_storage.getQueueLength(channel);

		if (currentIndex === null || currentIndex + 1 > queueLength) {
			return false;
		}

		const nextTrack = await this._playlist_storage.getTrackByIndex(
			channel,
			currentIndex + 1,
		);

		if (nextTrack !== null) {
			this.playTrack(channel, nextTrack);
			this._playlist_storage.setCurrent(channel, currentIndex + 1);
			return true;
		}

		return false;
	}

	private async pause(channel: VoiceBasedChannel): Promise<void> {
		const player = this._player_storage.get(channel);
		if (player) {
			player.pause();
		}
	}

	private async resume(channel: VoiceBasedChannel): Promise<void> {
		const player = this._player_storage.get(channel);
		if (player) {
			player.unpause();
		}
	}

	private async jump(channel: VoiceBasedChannel, to: number): Promise<void> {
		const currentIndex = await this._playlist_storage.getCurrentIndex(channel);

		if (currentIndex === null) {
			return;
		}

		const newIndex = currentIndex + to;
		const newTrack = await this._playlist_storage.getTrackByIndex(
			channel,
			newIndex,
		);

		if (newTrack === null) {
			return;
		}

		await this._playlist_storage.setCurrent(channel, newIndex);
		await this.playTrack(channel, newTrack);
	}

	@onlyVoiceChannel
	private async handleAdd(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	): Promise<void> {
		await interaction.deferReply();
		const query = interaction.options.get("query")?.value as string;

		const tracks = await this.getTracks(query);
		const added = await this._playlist_storage.addTracks(channel, tracks);

		if (added === 0) {
			interaction.editReply({
				embeds: [
					new EmbedBuilder().setDescription(
						"No track successful added, queue is full",
					),
				],
			});
		} else {
			interaction.editReply({
				embeds: [
					new EmbedBuilder().setDescription(`${added} track successful added`),
				],
			});
		}

		const connection = this._connection_storage.get(channel);
		if (!connection) {
			this.createConnection(interaction, channel);

			const current = await this._playlist_storage.getCurrentIndex(channel);

			if (current === null && tracks[0]) {
				this._playlist_storage.setCurrent(channel, 0);
				this.playTrack(channel, tracks[0]);
			}
		} else {
			const player = this._player_storage.get(channel);
			if (player && player.state.status === AudioPlayerStatus.Idle) {
				this.playingNext(channel);
			}
		}
	}

	@onlyVoiceChannel
	private async handlePause(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	) {
		await interaction.deferReply();
		await this.pause(channel);
		await interaction.editReply({
			embeds: [new EmbedBuilder().setDescription("Track is paused")],
		});
	}

	@onlyVoiceChannel
	private async handleResume(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	) {
		await interaction.deferReply();
		await this.resume(channel);
		await interaction.editReply({
			embeds: [new EmbedBuilder().setDescription("Track playback resumed")],
		});
	}

	@onlyVoiceChannel
	private async handleNext(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	) {
		await interaction.deferReply();

		const queueLength = await this._playlist_storage.getQueueLength(channel);
		const currentIndex = await this._playlist_storage.getCurrentIndex(channel);

		if (queueLength - 1 === currentIndex) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder().setDescription(
						"The current track is the last one in the queue",
					),
				],
			});

			return;
		}

		await this.playingNext(channel);
		await interaction.editReply({
			embeds: [new EmbedBuilder().setDescription("Playing next track")],
		});
	}

	@onlyVoiceChannel
	private async handlePrevious(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	) {
		await interaction.deferReply();

		const currentIndex = await this._playlist_storage.getCurrentIndex(channel);

		if (currentIndex === 0) {
			await interaction.editReply({
				embeds: [
					new EmbedBuilder().setDescription(
						"The current track is first in the queue",
					),
				],
			});

			return;
		}

		await this.playPrevious(channel);
		await interaction.editReply({
			embeds: [new EmbedBuilder().setDescription("Playing previous track")],
		});
	}

	@onlyVoiceChannel
	private async handleQueue(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	): Promise<void> {
		await interaction.deferReply();
		const embed = new EmbedBuilder();

		const queue = await this._playlist_storage.getQueue(channel);
		const currentIndex = await this._playlist_storage.getCurrentIndex(channel);

		if (queue.length > 0) {
			const queueList = queue
				.map((track, index) => {
					if (index === currentIndex) {
						return `▶️ **${track.title}**`;
					}
					const position = currentIndex !== null ? index - currentIndex : index;
					return `**${position}.** ${track.title}`;
				})
				.filter(Boolean)
				.join("\n");

			if (queueList.length > 0) {
				embed.setDescription(queueList);
			} else {
				embed.setDescription("No tracks in queue");
			}
		} else {
			embed.setDescription("No tracks in queue");
		}

		await interaction.editReply({ embeds: [embed] });
	}

	@onlyVoiceChannel
	private async handleCurrent(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	): Promise<void> {
		await interaction.deferReply();

		const track = await this._playlist_storage.getCurrentTrack(channel);
		if (track === null) {
			await interaction.editReply({
				embeds: [new EmbedBuilder().setDescription("No current track")],
			});
			return;
		}

		await interaction.editReply({
			embeds: [
				new EmbedBuilder()
					.setThumbnail(track.thumbnail)
					.setURL(track.url)
					.setTitle(track.title)
					.setDescription(formatDuration(track.duration)),
			],
		});
	}

	@onlyVoiceChannel
	private async handleJump(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	): Promise<void> {
		await interaction.deferReply();
		const to = interaction.options.get("to")?.value as number;

		if (!Number.isInteger(to)) {
			await interaction.editReply({
				embeds: [new EmbedBuilder().setDescription("Not a valid number")],
			});
			return;
		}

		const queueLen = await this._playlist_storage.getQueueLength(channel);
		const currentIndex = await this._playlist_storage.getCurrentIndex(channel);

		if (currentIndex === null) {
			return;
		}

		if (to < -currentIndex || to > queueLen - currentIndex - 1) {
			await interaction.editReply({
				embeds: [new EmbedBuilder().setDescription("Not a valid number")],
			});
			return;
		}

		await this.jump(channel, to);
		await interaction.editReply({
			embeds: [
				new EmbedBuilder().setDescription(`Jump to ${to} track in queue`),
			],
		});
		return;
	}

	@onlyVoiceChannel
	private async handleLeave(
		interaction: CommandInteraction,
		channel: VoiceBasedChannel,
	): Promise<void> {
		await interaction.deferReply();

		const connection = this._connection_storage.get(channel);
		if (connection) {
			connection.disconnect();
			await this.clearStorage(channel);
			await interaction.editReply({
				embeds: [
					new EmbedBuilder().setDescription(
						"Bot has successfully exited the voice channel",
					),
				],
			});
			return;
		}

		await interaction.editReply({
			embeds: [
				new EmbedBuilder().setDescription(
					"Bot is no longer in the voice channel",
				),
			],
		});
		return;
	}

	private async handleHelp(interaction: CommandInteraction): Promise<void> {
		await interaction.deferReply();

		const commands = this._commands
			.map((c, i, m) => {
				return `**/${c.name}**\n${c.description}\n${i < m.length && "\n"}`;
			})
			.join("");

		await interaction.editReply({
			embeds: [
				new EmbedBuilder().setDescription(commands).setTitle("Commands"),
			],
		});
	}

	private async handleCommand(interaction: CommandInteraction): Promise<void> {
		const { commandName, guildId, member } = interaction;

		if (!guildId) {
			await interaction.reply({
				embeds: [
					new EmbedBuilder().setDescription(
						"This command can only be used in a server",
					),
				],
			});
			return;
		}

		const guildMember = member as GuildMember;
		const voiceChannel = guildMember.voice.channel as VoiceBasedChannel;

		switch (commandName) {
			case "add":
				await this.handleAdd(interaction, voiceChannel);
				break;
			case "pause":
				await this.handlePause(interaction, voiceChannel);
				break;
			case "resume":
				await this.handleResume(interaction, voiceChannel);
				break;
			case "next":
				await this.handleNext(interaction, voiceChannel);
				break;
			case "previous":
				await this.handlePrevious(interaction, voiceChannel);
				break;
			case "jump":
				await this.handleJump(interaction, voiceChannel);
				break;
			case "queue":
				await this.handleQueue(interaction, voiceChannel);
				break;
			case "current":
				await this.handleCurrent(interaction, voiceChannel);
				break;
			case "leave":
				await this.handleLeave(interaction, voiceChannel);
				break;
			case "help":
				await this.handleHelp(interaction);
				break;
		}
	}

	public constructor(token: string) {
		this._playlist_storage = new PlaylistStorage({
			url: `valkey://${process.env.VALKEY_HOST}:${process.env.VALKEY_PORT}`,
		});

		this._connection_storage = new ConnectionStorage();

		this._player_storage = new PlayerStorage();

		this._client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.GuildVoiceStates,
				GatewayIntentBits.MessageContent,
			],
		});

		this._client.once("ready", () => {
			console.log(`${this._client.user?.tag} is online`);
			this.registerCommands();

			this._client.user?.setPresence({
				activities: [
					{
						name: "github.com/nickshiro",
						url: "https://github.com/nickshiro",
						type: ActivityType.Custom,
					},
				],
				status: "online",
			});
		});

		this._client.on("interactionCreate", async (interaction) => {
			if (!interaction.isChatInputCommand()) return;
			await this.handleCommand(interaction);
		});

		this._client
			.login(token)
			.then(() => {
				console.log("Start bot");
			})
			.catch((err) => {
				console.error("Failed to start bot:", err);
			});
	}
}
