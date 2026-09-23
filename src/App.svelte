<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { FFmpeg } from "@ffmpeg/ffmpeg";
  import { fetchFile, toBlobURL } from "@ffmpeg/util";

  let loaded = $state<boolean>(false);
  let loading = $state<boolean>(false);
  let transcoding = $state<boolean>(false);
  let error = $state<string>("");
  let ffmpeg: FFmpeg;
  let videoSegments = $state<
    Array<{ name: string; url: string; start: number; end: number }>
  >([]);
  let selectedFile = $state<File | null>(null);
  let sourceDuration = $state<number>(0);
  let fileInputElement = $state<HTMLInputElement>();
  let dragOver = $state<boolean>(false);
  let messageElement = $state<HTMLParagraphElement>();

  // New state variables for start time and segment length
  let startTime = $state<string>("00:00:00");
  let segmentLength = $state<number>(3);

  // Cut mode: "custom" keeps the original format, "rounds" enables the
  // boxing presets (a round of fighting followed by a break).
  type CutMode = "custom" | "rounds";
  type RoundPreset = "roundAndPause" | "fightOnly";
  let cutMode = $state<CutMode>("custom");
  let roundPreset = $state<RoundPreset>("fightOnly");
  let roundLength = $state<number>(180);
  let breakLength = $state<number>(60);

  onMount(() => {
    // Initialize FFmpeg instance
    ffmpeg = new FFmpeg();
  });

  onDestroy(() => {
    // Clean up all video URLs when component is destroyed
    videoSegments.forEach((segment) => URL.revokeObjectURL(segment.url));
  });

  const load = async (): Promise<void> => {
    try {
      loading = true;
      error = "";

      // Use the latest stable version
      const baseURL: string =
        "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

      ffmpeg.on("log", ({ message }: { message: string }) => {
        if (messageElement) {
          messageElement.textContent = message;
        }
        console.log(message);
      });

      ffmpeg.on("progress", ({ progress }: { progress: number }) => {
        console.log(`Progress: ${progress * 100}%`);
      });

      // Load FFmpeg
      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.js`,
          "text/javascript",
        ),
        wasmURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.wasm`,
          "application/wasm",
        ),
      });

      loaded = true;
      console.log("FFmpeg loaded successfully");
    } catch (err) {
      error = `Failed to load FFmpeg: ${err instanceof Error ? err.message : String(err)}`;
      console.error(error);
    } finally {
      loading = false;
    }
  };

  const handleFileSelect = (event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];

    if (file) {
      processFile(file);
    }
  };

  const processFile = (file: File) => {
    // Check if it's a video file
    if (file.type.startsWith("video/")) {
      selectedFile = file;
      sourceDuration = 0;
      getVideoDuration(file)
        .then((duration) => {
          sourceDuration = duration;
        })
        .catch(() => {
          sourceDuration = 0;
        });
      console.log(
        "Selected video:",
        file.name,
        "Size:",
        (file.size / 1024 / 1024).toFixed(2),
        "MB",
      );
      error = ""; // Clear any previous errors
    } else {
      error = "Please select a valid video file";
      selectedFile = null;
    }
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    dragOver = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    dragOver = true;
  };

  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault();
    dragOver = false;
  };

  const validateTimeFormat = (time: string): boolean => {
    // Check if time matches HH:MM:SS or MM:SS or SS format
    const timeRegex = /^(\d{1,2}:)?(\d{1,2}:)?\d{1,2}(\.\d+)?$/;
    return timeRegex.test(time);
  };

  const timeToSeconds = (time: string): number => {
    return time
      .split(":")
      .map((part) => Number(part))
      .reduce((acc, part) => acc * 60 + part, 0);
  };

  const getVideoDuration = (file: File): Promise<number> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      const url = URL.createObjectURL(file);
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(video.duration);
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read video metadata"));
      };
      video.src = url;
    });
  };

  const formatTimestamp = (totalSeconds: number): string => {
    const secs = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
  };

  const collectOutputs = async (
    sourceStart: number,
    segmentSeconds: number,
    cycle = 0,
  ): Promise<void> => {
    // Clean up previous video segments
    videoSegments.forEach((segment) => URL.revokeObjectURL(segment.url));
    videoSegments = [];

    // List all files to see what was created
    const files = await ffmpeg.listDir("/");
    console.log("Available files:", files);

    // Find all output files
    const outputFiles = files
      .map((file) => file.name)
      .filter((name) => name.startsWith("output_") && name.endsWith(".mp4"))
      .sort(); // Sort to maintain order

    console.log("Found output segments:", outputFiles);

    // Timestamps are derived from the cut schedule so they always line up
    // with the requested segments, regardless of keyframe placement.
    const endLimit = sourceDuration > 0 ? sourceDuration : Infinity;

    for (let i = 0; i < outputFiles.length; i++) {
      const fileName = outputFiles[i];
      try {
        const data = await ffmpeg.readFile(fileName);
        const blob = new Blob([data], { type: "video/mp4" });
        const url = URL.createObjectURL(blob);

        // In cycle mode (fight only) rounds are spaced by round + break.
        const rawStart =
          cycle > 0
            ? sourceStart + i * cycle
            : sourceStart + i * segmentSeconds;

        videoSegments.push({
          name: fileName,
          url: url,
          start: Math.min(rawStart, endLimit),
          end: Math.min(rawStart + segmentSeconds, endLimit),
        });
      } catch (err) {
        console.warn(`Failed to read ${fileName}:`, err);
      }
    }
  };

  const clearPreviousFiles = async (): Promise<void> => {
    // ffmpeg.wasm keeps its in-memory filesystem between runs, so stale
    // outputs from a previous, longer run would otherwise be listed again.
    const files = await ffmpeg.listDir("/");
    for (const file of files) {
      if (
        !file.isDir &&
        (file.name.startsWith("output_") || file.name.startsWith("input."))
      ) {
        try {
          await ffmpeg.deleteFile(file.name);
        } catch (err) {
          console.warn(`Failed to delete ${file.name}:`, err);
        }
      }
    }
  };

  const writeInputFile = async (): Promise<string> => {
    // Use the selected file instead of downloading from URL
    console.log("Processing selected file:", selectedFile!.name);

    // Convert File to Uint8Array
    const arrayBuffer = await selectedFile!.arrayBuffer();
    const videoData = new Uint8Array(arrayBuffer);

    // Get file extension from the selected file
    const fileExtension =
      selectedFile!.name.split(".").pop()?.toLowerCase() || "mp4";
    const inputFileName = `input.${fileExtension}`;
    console.log("Writing input file: " + inputFileName);
    await ffmpeg.writeFile(inputFileName, videoData);

    return inputFileName;
  };

  // Original behaviour: split the video into fixed-length segments.
  const transcodeSegments = async (segmentSeconds: number): Promise<void> => {
    const inputFileName = await writeInputFile();

    console.log("Starting FFmpeg processing...");

    // Build FFmpeg command with start time and custom segment length
    const ffmpegArgs = [
      "-i",
      inputFileName,
      "-ss", // Start time option
      startTime,
      "-f",
      "segment",
      "-segment_time",
      segmentSeconds.toString(), // Use custom segment length
      "-c",
      "copy", // Copy streams without re-encoding for faster processing
      "-reset_timestamps",
      "1",
      "-map",
      "0",
      "output_%03d.mp4",
    ];

    console.log("FFmpeg command:", ffmpegArgs.join(" "));
    await ffmpeg.exec(ffmpegArgs);
    await collectOutputs(timeToSeconds(startTime), segmentSeconds);
  };

  // Boxing preset: cut only the fighting rounds and drop the breaks in between.
  const transcodeFightOnly = async (): Promise<void> => {
    const inputFileName = await writeInputFile();

    const startSeconds = timeToSeconds(startTime);
    const cycle = roundLength + breakLength;
    const duration = await getVideoDuration(selectedFile!);
    const roundCount = Math.max(0, Math.ceil((duration - startSeconds) / cycle));

    console.log(
      `Fight-only mode: ${roundCount} round(s) of ${roundLength}s, skipping ${breakLength}s between rounds`,
    );

    // Each round starts at start + i * (round + break) and is cut for roundLength.
    for (let i = 0; i < roundCount; i++) {
      const offset = startSeconds + i * cycle;
      const outputName = `output_${String(i).padStart(3, "0")}.mp4`;
      const ffmpegArgs = [
        "-ss",
        offset.toString(),
        "-i",
        inputFileName,
        "-t",
        roundLength.toString(),
        "-c",
        "copy",
        outputName,
      ];

      console.log("FFmpeg command:", ffmpegArgs.join(" "));
      await ffmpeg.exec(ffmpegArgs);
    }

    await collectOutputs(startSeconds, roundLength, cycle);
  };

  const transcode = async (): Promise<void> => {
    if (!loaded) {
      error = "FFmpeg not loaded yet";
      return;
    }
    if (!selectedFile) {
      error = "Please select a video file first";
      return;
    }
    if (!validateTimeFormat(startTime)) {
      error = "Invalid start time format. Use HH:MM:SS, MM:SS, or SS format";
      return;
    }

    const roundsMode = cutMode === "rounds";
    const segmentSeconds = roundsMode
      ? roundLength + breakLength
      : segmentLength;

    if (roundsMode) {
      if (roundLength <= 0 || breakLength < 0) {
        error =
          "Round length must be greater than 0 and break length cannot be negative";
        return;
      }
    } else if (segmentLength <= 0) {
      error = "Segment length must be greater than 0";
      return;
    }

    try {
      transcoding = true;
      error = "";

      console.log("Starting transcoding...");
      console.log(
        `Start time: ${startTime}, Mode: ${
          roundsMode ? `rounds (${roundPreset})` : "custom"
        }, Segment length: ${segmentSeconds}s`,
      );

      await clearPreviousFiles();

      if (roundsMode && roundPreset === "fightOnly") {
        await transcodeFightOnly();
      } else {
        await transcodeSegments(segmentSeconds);
      }

      console.log(`Successfully loaded ${videoSegments.length} video segments`);
    } catch (err) {
      error = `Transcoding failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(error);
    } finally {
      transcoding = false;
    }
  };
</script>

<main>
  {#if error}
    <div class="error">
      <p><strong>Error:</strong> {error}</p>
      <button
        onclick={() => {
          error = "";
          loaded = false;
        }}>Reset</button
      >
    </div>
  {/if}

  {#if loaded}
    <div
      class="file-input-section {dragOver ? 'drag-over' : ''}"
      ondrop={handleDrop}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
    >
      <h3>Select Video File</h3>
      <p>Drag and drop a video file here, or click to browse</p>
      <input
        bind:this={fileInputElement}
        type="file"
        accept="video/*"
        onchange={handleFileSelect}
        class="file-input"
      />
      {#if selectedFile}
        <p class="file-info">
          <strong>Selected:</strong>
          {selectedFile.name}
          ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
          {#if sourceDuration > 0}
            | <strong>Length:</strong> {formatTimestamp(sourceDuration)}
          {/if}
        </p>
      {/if}
    </div>

    <!-- New input controls section -->
    <div class="controls-section">
      <h3>Processing Options</h3>
      <div class="input-group">
        <label for="startTime">Start Time:</label>
        <input
          id="startTime"
          bind:value={startTime}
          type="text"
          placeholder="00:00:00 or MM:SS or SS"
          class="time-input"
        />
        <small
          >Format: HH:MM:SS, MM:SS, or SS (e.g., 01:30:00, 90, or 1:30)</small
        >
      </div>

      <div class="input-group">
        <span class="group-label">Cut Mode:</span>
        <label class="radio-label">
          <input type="radio" bind:group={cutMode} value="custom" />
          Custom segment length
        </label>
        <label class="radio-label">
          <input type="radio" bind:group={cutMode} value="rounds" />
          Boxing rounds preset
        </label>
      </div>

      {#if cutMode === "custom"}
        <div class="input-group">
          <label for="segmentLength">Segment Length (seconds):</label>
          <input
            id="segmentLength"
            bind:value={segmentLength}
            type="number"
            min="1"
            step="0.1"
            class="number-input"
          />
          <small>Length of each video segment in seconds</small>
        </div>
      {:else}
        <div class="input-group">
          <span class="group-label">Round Preset:</span>
          <label class="radio-label">
            <input type="radio" bind:group={roundPreset} value="roundAndPause" />
            Round + pause (one {roundLength + breakLength}s clip)
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={roundPreset} value="fightOnly" />
            Fights only (cut {roundLength}s, skip {breakLength}s)
          </label>
        </div>

        <div class="input-group">
          <label for="roundLength">Round Length (seconds):</label>
          <input
            id="roundLength"
            bind:value={roundLength}
            type="number"
            min="1"
            step="1"
            class="number-input"
          />
        </div>

        <div class="input-group">
          <label for="breakLength">Break Length (seconds):</label>
          <input
            id="breakLength"
            bind:value={breakLength}
            type="number"
            min="0"
            step="1"
            class="number-input"
          />
          <small>Pause between rounds (skipped in "Fights only" mode)</small>
        </div>
      {/if}

      <button
        class="transcode-button"
        onclick={transcode}
        disabled={transcoding || !selectedFile}
      >
        {transcoding
          ? "Processing..."
          : selectedFile
            ? cutMode === "rounds"
              ? roundPreset === "fightOnly"
                ? `Cut ${roundLength}s fights, skip ${breakLength}s breaks from ${startTime}`
                : `Split into ${roundLength + breakLength}s round + pause clips from ${startTime}`
              : `Split video into ${segmentLength}s segments starting at ${startTime}`
            : "Select a video file first"}
      </button>
    </div>

    {#if videoSegments.length > 0}
      <div class="video-grid">
        <h3>Video Segments ({videoSegments.length} total)</h3>
        <p class="segment-info">
          Started at: <strong>{startTime}</strong> |
          {#if cutMode === "rounds"}
            {roundPreset === "fightOnly"
              ? `Rounds only: ${roundLength}s cut / ${breakLength}s skipped`
              : `Round + pause: ${roundLength + breakLength}s per clip`}
          {:else}
            Segment length: <strong>{segmentLength}s</strong>
          {/if}
        </p>
        {#each videoSegments as segment, index}
          <div class="video-segment">
            <h4>Segment {index + 1}: {segment.name}</h4>
            <p class="segment-time">
              <strong>{formatTimestamp(segment.start)}</strong>
              → <strong>{formatTimestamp(segment.end)}</strong>
              <span class="segment-duration"
                >({formatTimestamp(segment.end - segment.start)})</span
              >
            </p>
            <video
              src={segment.url}
              controls
              style="max-width: 100%; height: auto;"
            >
              Your browser does not support the video tag.
            </video>
          </div>
        {/each}
      </div>
    {:else}
      <p>
        No video segments loaded yet. Configure your options and click the
        button below to process a video.
      </p>
    {/if}

    <p bind:this={messageElement}></p>
    <p><em>Open Developer Tools (Ctrl+Shift+I) to view detailed logs</em></p>
  {:else}
    <button onclick={load} disabled={loading}>
      {loading ? "Loading FFmpeg..." : "Load FFmpeg (~31 MB)"}
    </button>
  {/if}

  {#if loading}
    <p>Please wait, downloading and initializing FFmpeg...</p>
  {/if}

  {#if transcoding}
    <p>Processing video, please wait...</p>
  {/if}
</main>

<style>
  main {
    padding: 20px;
    max-width: 800px;
    margin: 0 auto;
  }

  .error {
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    color: var(--text);
    padding: 10px;
    margin: 10px 0;
    border-radius: 4px;
  }

  button {
    padding: 10px 20px;
    margin: 5px;
    border: none;
    background: var(--accent);
    color: #ffffff;
    border-radius: 4px;
    cursor: pointer;
  }

  button:disabled {
    background: var(--disabled);
    cursor: not-allowed;
  }

  button:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .file-input-section {
    margin: 20px 0;
    padding: 20px;
    border: 2px dashed var(--border);
    border-radius: 8px;
    background: var(--surface-dashed);
    color: var(--text);
    text-align: center;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .file-input-section:hover,
  .file-input-section.drag-over {
    border-color: var(--accent);
    background: var(--drag-bg);
  }

  .file-input {
    margin: 10px 0;
    padding: 5px;
    color: var(--text);
  }

  .file-input::file-selector-button {
    margin-right: 10px;
    padding: 8px 14px;
    border: none;
    border-radius: 4px;
    background: var(--accent);
    color: #ffffff;
    font: inherit;
    cursor: pointer;
  }

  .file-input::file-selector-button:hover {
    background: var(--accent-hover);
  }

  .file-info {
    color: var(--text-muted);
    font-size: 14px;
    margin: 10px 0;
  }

  .controls-section {
    margin: 20px 0;
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-alt);
    color: var(--text);
  }

  .transcode-button {
    width: 100%;
    margin: 10px 0 0 0;
  }

  .controls-section h3 {
    margin: 0 0 15px 0;
    color: var(--text-strong);
  }

  .input-group {
    margin: 15px 0;
  }

  .input-group label {
    display: block;
    margin-bottom: 5px;
    font-weight: bold;
    color: var(--text);
  }

  .input-group .group-label {
    display: block;
    margin-bottom: 8px;
    font-weight: bold;
    color: var(--text);
  }

  .radio-label {
    display: flex !important;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-weight: normal !important;
    cursor: pointer;
  }

  .radio-label input[type="radio"] {
    width: auto;
    margin: 0;
    accent-color: var(--accent);
  }

  .time-input,
  .number-input {
    width: 200px;
    padding: 8px 12px;
    background: var(--field-bg);
    color: var(--field-text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 14px;
  }

  .time-input:focus,
  .number-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .input-group small {
    display: block;
    margin-top: 5px;
    color: var(--text-muted);
    font-size: 12px;
  }

  .video-grid {
    margin: 20px 0;
  }

  .segment-info {
    background: var(--info-bg);
    padding: 10px;
    border-radius: 4px;
    margin: 10px 0;
    font-size: 14px;
    color: var(--info-text);
  }

  .video-segment {
    margin: 15px 0;
    padding: 15px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-alt);
    color: var(--text);
  }

  .video-segment h4 {
    margin: 0 0 10px 0;
    color: var(--text-strong);
    font-size: 14px;
  }

  .segment-time {
    margin: 0 0 10px 0;
    font-size: 13px;
    color: var(--info-text);
  }

  .segment-duration {
    color: var(--text-muted);
  }
</style>
