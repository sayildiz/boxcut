<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { FFmpeg } from "@ffmpeg/ffmpeg";
  import { fetchFile, toBlobURL } from "@ffmpeg/util";
  import {
    DEFAULT_DETECT_CONFIG,
    detectBoundaries,
    filterPlausibleOnsets,
    onsetsToRounds,
    toInt16Array,
    type Segment,
  } from "./audioDetection";
  import { detectGong, YAMNET_SAMPLE_RATE } from "./yamnet";
  import {
    extractFingerprint,
    findFingerprintMatches,
    mergeOnsetHits,
    type OnsetHit,
  } from "./toneFingerprint";

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

  // New state variables for start time and segment length
  let startTime = $state<string>("00:00:00");
  let segmentLength = $state<number>(3);

  // Cut mode: "custom" keeps the original format, "rounds" enables the
  // boxing presets (a round of fighting followed by a break), and "auto"
  // detects bell onsets from the audio and cuts the resulting intervals.
  type CutMode = "custom" | "rounds" | "auto";
  type RoundPreset = "roundAndPause" | "fightOnly";
  let cutMode = $state<CutMode>("custom");
  let roundPreset = $state<RoundPreset>("fightOnly");
  let roundLength = $state<number>(180);
  let breakLength = $state<number>(60);

  // Audio-detection state.
  type DetectedClip = Segment & { isBreak: boolean; enabled: boolean };
  type DetectBackend = "model" | "energy";
  let detecting = $state<boolean>(false);
  let detectStatus = $state<string>("");
  let detectBackend = $state<DetectBackend>("model");
  let onsets = $state<number[]>([]);
  let detectedClips = $state<DetectedClip[]>([]);
  let detectedIntervals = $state<Array<Segment & { isBreak: boolean }>>([]);
  let breakPatternFound = $state<boolean>(false);
  let includeBreaks = $state<boolean>(false);
  let detectSensitivity = $state<number>(DEFAULT_DETECT_CONFIG.sensitivityDb);
  let detectThreshold = $state<number>(0.3);
  let detectMinGap = $state<number>(DEFAULT_DETECT_CONFIG.minGapSec);
  let detectRoundLength = $state<number>(180);
  let detectBreakLength = $state<number>(60);
  let detectGongTail = $state<boolean>(true);
  let detectGongTailSec = $state<number>(2);
  let rejectedOnsets = $state<number>(0);

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

  // `segmentAt` derives display timestamps from the cut schedule (or from the
  // detected intervals), so they line up with the requested clips regardless
  // of keyframe placement.
  const collectOutputs = async (
    segmentAt: (index: number) => Segment,
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

    const endLimit = sourceDuration > 0 ? sourceDuration : Infinity;

    for (let i = 0; i < outputFiles.length; i++) {
      const fileName = outputFiles[i];
      try {
        const data = await ffmpeg.readFile(fileName);
        const blob = new Blob([data], { type: "video/mp4" });
        const url = URL.createObjectURL(blob);
        const segment = segmentAt(i);

        videoSegments.push({
          name: fileName,
          url: url,
          start: Math.min(segment.start, endLimit),
          end: Math.min(segment.end, endLimit),
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
        (file.name.startsWith("output_") ||
          file.name.startsWith("input.") ||
          file.name === "audio.pcm")
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
    const start = timeToSeconds(startTime);
    await collectOutputs((i) => ({
      start: start + i * segmentSeconds,
      end: start + (i + 1) * segmentSeconds,
    }));
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

    await collectOutputs((i) => ({
      start: startSeconds + i * cycle,
      end: startSeconds + i * cycle + roundLength,
    }));
  };

  const applyBreakInclusion = (): void => {
    for (const clip of detectedClips) {
      clip.enabled = includeBreaks || !clip.isBreak;
    }
  };

  // Materialise reviewable clips from the detected intervals. Gong strikes are
  // reported slightly after the physical hit, and a hard cut at the boundary
  // chops the ring off, so an optional tail keeps the closing gong audible.
  const rebuildDetectedClips = (): void => {
    const tail = detectGongTail ? Math.max(0, detectGongTailSec) : 0;
    const enabledBefore = detectedClips.map((clip) => clip.enabled);
    detectedClips = detectedIntervals.map((interval, index) => ({
      start: interval.start,
      end:
        sourceDuration > 0
          ? Math.min(interval.end + tail, sourceDuration)
          : interval.end + tail,
      isBreak: interval.isBreak,
      enabled: enabledBefore[index] ?? !interval.isBreak,
    }));
  };

  // Decode the video's audio to mono PCM, scan for bell onsets, and turn them
  // into candidate fight/break clips for the user to review before cutting.
  const runDetection = async (): Promise<void> => {
    if (!loaded || !selectedFile) {
      error = "Load FFmpeg and select a video first";
      return;
    }
    if (!validateTimeFormat(startTime)) {
      error = "Invalid start time format. Use HH:MM:SS, MM:SS, or SS format";
      return;
    }
    if (
      detectRoundLength <= 0 ||
      detectBreakLength <= 0 ||
      detectMinGap <= 0 ||
      detectGongTailSec < 0 ||
      (detectBackend === "energy" && detectSensitivity <= 0) ||
      (detectBackend === "model" && (detectThreshold <= 0 || detectThreshold >= 1))
    ) {
      error = "Detection settings must be valid numbers";
      return;
    }

    detecting = true;
    error = "";
    detectStatus =
      detectBackend === "model" ? "Loading model…" : "Analyzing audio…";
    onsets = [];
    rejectedOnsets = 0;
    detectedClips = [];
    detectedIntervals = [];
    breakPatternFound = false;
    try {
      console.log("Extracting audio for detection...");
      await clearPreviousFiles();
      const inputFileName = await writeInputFile();
      const sampleRate =
        detectBackend === "model"
          ? YAMNET_SAMPLE_RATE
          : DEFAULT_DETECT_CONFIG.sampleRate;
      await ffmpeg.exec([
        "-i",
        inputFileName,
        "-vn",
        "-ac",
        "1",
        "-ar",
        sampleRate.toString(),
        "-f",
        "s16le",
        "audio.pcm",
      ]);
      const pcmData = await ffmpeg.readFile("audio.pcm");
      if (typeof pcmData === "string") {
        throw new Error("Unexpected text data returned for audio.pcm");
      }
      const pcm = toInt16Array(pcmData);
      console.log(`Analyzing ${pcm.length} audio samples @ ${sampleRate} Hz...`);

      const start = timeToSeconds(startTime);
      let candidateOnsets: number[] = [];
      let candidateScores: number[] | undefined;
      if (detectBackend === "model") {
        detectStatus = "Running gong classifier…";
        const result = await detectGong(pcm, {
          threshold: detectThreshold,
          minGapSec: detectMinGap,
          onProgress: (done, total) => {
            detectStatus = `Analyzing audio ${done}/${total}…`;
          },
        });
        console.log("Top classes per frame:", result.topClassNames);
        let hits: OnsetHit[] = result.onsets.map((time, i) => ({
          time,
          score: result.onsetScores[i],
        }));
        // The model is confident about some gongs and blind to identical ones
        // later in the recording. Learn the gong's tonal fingerprint from the
        // strongest hit and scan for repeats, then merge both lists.
        const anchor = hits.reduce<OnsetHit | null>(
          (best, hit) => (!best || hit.score > best.score ? hit : best),
          null,
        );
        if (anchor) {
          detectStatus = "Matching the gong's tone…";
          const fingerprint = extractFingerprint(
            pcm,
            YAMNET_SAMPLE_RATE,
            anchor.time,
          );
          if (fingerprint) {
            const matches = findFingerprintMatches(
              pcm,
              YAMNET_SAMPLE_RATE,
              fingerprint,
            );
            console.log(
              `Gong fingerprint: ${fingerprint.freqs
                .map((f) => `${f.toFixed(0)} Hz`)
                .join(" + ")} (${fingerprint.strengthDb.toFixed(0)} dB) → ${matches.length} match(es)`,
            );
            hits = mergeOnsetHits([hits, matches], detectMinGap);
          }
        }
        const kept = hits.filter((hit) => hit.time >= start);
        candidateOnsets = kept.map((hit) => hit.time);
        candidateScores = kept.map((hit) => hit.score);
      } else {
        detectStatus = "Scanning for loudness peaks…";
        const config = {
          ...DEFAULT_DETECT_CONFIG,
          sensitivityDb: detectSensitivity,
          minGapSec: detectMinGap,
        };
        candidateOnsets = detectBoundaries(pcm, config).filter((t) => t >= start);
      }

      // Only keep gongs that are ~roundLength apart (a round) or
      // ~detectBreakLength apart (a break); anything else is a false positive.
      const plausible = filterPlausibleOnsets(
        candidateOnsets,
        candidateScores,
        detectRoundLength,
        detectBreakLength,
      );
      onsets = plausible.onsets;
      rejectedOnsets = plausible.rejected;

      const mapped = onsetsToRounds(
        onsets,
        detectRoundLength,
        detectBreakLength,
      );
      breakPatternFound = mapped.breakPatternFound;
      detectedIntervals = mapped.intervals;
      rebuildDetectedClips();
      console.log(
        `Detected onsets: ${onsets.length} (${rejectedOnsets} rejected as out-of-rhythm)`,
        onsets,
      );
      console.log("Detected clips:", detectedClips);
      if (onsets.length === 0) {
        error =
          candidateOnsets.length > 0
            ? `Found ${candidateOnsets.length} bell-like sound(s), but none fit a ${detectRoundLength}s round or ${detectBreakLength}s break rhythm. Lower the threshold or adjust the expected lengths.`
            : detectBackend === "model"
              ? "No gong/bell detected. Try lowering the threshold, or switch to the loudness backend."
              : "No bell onsets detected. Try lowering the sensitivity, or check that the audio has a clear bell.";
      }
    } catch (err) {
      error = `Audio detection failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(error);
    } finally {
      detecting = false;
    }
  };

  // Cut the intervals the user approved in the detection results.
  const transcodeDetected = async (): Promise<void> => {
    const clips = detectedClips.filter(
      (clip) => clip.enabled && clip.end - clip.start > 0,
    );
    if (clips.length === 0) {
      throw new Error("No valid detected clips to cut");
    }
    const inputFileName = await writeInputFile();
    console.log(`Cutting ${clips.length} audio-detected clip(s)...`);

    const fileExists = async (name: string): Promise<boolean> => {
      const files = await ffmpeg.listDir("/");
      return files.some((f) => !f.isDir && f.name === name);
    };

    const written: Segment[] = [];
    for (const clip of clips) {
      const duration = clip.end - clip.start;
      const outputName = `output_${String(written.length).padStart(3, "0")}.mp4`;
      const baseArgs = [
        "-ss",
        clip.start.toString(),
        "-i",
        inputFileName,
        "-t",
        duration.toString(),
      ];

      // Fast path: stream copy. Some codecs/containers cannot be copied into
      // mp4 or land on a keyframe edge and yield no file, so fall back to a
      // quick re-encode for this clip.
      try {
        const copyCode = await ffmpeg.exec([
          ...baseArgs,
          "-c",
          "copy",
          outputName,
        ]);
        if (copyCode === 0 && (await fileExists(outputName))) {
          written.push({ start: clip.start, end: clip.end });
          continue;
        }
      } catch (err) {
        console.warn("Stream-copy cut failed, re-encoding:", err);
      }

      console.warn(`Re-encoding ${outputName} (stream copy produced nothing)`);
      try {
        const encodeCode = await ffmpeg.exec([
          ...baseArgs,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-c:a",
          "aac",
          outputName,
        ]);
        if (encodeCode === 0 && (await fileExists(outputName))) {
          written.push({ start: clip.start, end: clip.end });
        } else {
          console.warn(`Failed to produce ${outputName} (code ${encodeCode})`);
        }
      } catch (err) {
        console.warn(`Re-encode failed for ${outputName}:`, err);
      }
    }

    if (written.length === 0) {
      throw new Error(
        "FFmpeg produced no clips for the detected intervals (codec may be unsupported)",
      );
    }
    await collectOutputs((i) => written[i]);
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
    const autoMode = cutMode === "auto";
    const segmentSeconds = roundsMode
      ? roundLength + breakLength
      : segmentLength;

    if (autoMode) {
      if (detectedClips.filter((clip) => clip.enabled).length === 0) {
        error = "Detect rounds and select at least one clip first";
        return;
      }
    } else if (roundsMode) {
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
          autoMode ? "auto (audio)" : roundsMode ? `rounds (${roundPreset})` : "custom"
        }, Segment length: ${segmentSeconds}s`,
      );

      await clearPreviousFiles();

      if (autoMode) {
        await transcodeDetected();
      } else if (roundsMode && roundPreset === "fightOnly") {
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
        <label class="radio-label">
          <input type="radio" bind:group={cutMode} value="auto" />
          Auto-detect rounds from audio (beta)
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
      {:else if cutMode === "rounds"}
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
      {:else}
        <div class="input-group">
          <span class="group-label">Detection method:</span>
          <label class="radio-label">
            <input type="radio" bind:group={detectBackend} value="model" />
            Gong classifier (YAMNet)
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={detectBackend} value="energy" />
            Loudness peaks
          </label>
        </div>

        {#if detectBackend === "model"}
          <div class="input-group">
            <label for="detectThreshold">Confidence threshold:</label>
            <input
              id="detectThreshold"
              bind:value={detectThreshold}
              type="number"
              min="0.05"
              max="0.95"
              step="0.05"
              class="number-input"
            />
            <small
              >Lower = more sensitive. First detection downloads the YAMNet model
              (~16 MB) + WASM runtime (~15 MB).</small
            >
          </div>
        {:else}
          <div class="input-group">
            <label for="detectSensitivity">Sensitivity (dB above noise):</label>
            <input
              id="detectSensitivity"
              bind:value={detectSensitivity}
              type="number"
              min="2"
              max="30"
              step="1"
              class="number-input"
            />
            <small>Lower = more sensitive (but more false positives)</small>
          </div>
        {/if}

        <div class="input-group">
          <label for="detectMinGap">Minimum gap between bells (seconds):</label>
          <input
            id="detectMinGap"
            bind:value={detectMinGap}
            type="number"
            min="0.5"
            max="30"
            step="0.5"
            class="number-input"
          />
        </div>

        <div class="input-group">
          <label for="detectRoundLength">Expected round length (seconds):</label>
          <input
            id="detectRoundLength"
            bind:value={detectRoundLength}
            type="number"
            min="10"
            step="1"
            class="number-input"
          />
          <small
            >Gongs must land about this far apart (or the break length below) to
            count; other intervals are treated as false positives</small
          >
        </div>

        <div class="input-group">
          <label for="detectBreakLength">Expected break length (seconds):</label>
          <input
            id="detectBreakLength"
            bind:value={detectBreakLength}
            type="number"
            min="5"
            step="1"
            class="number-input"
          />
          <small>Used to tell the round-end/start bell pair apart from round boundaries</small>
        </div>

        <div class="input-group">
          <label class="radio-label">
            <input
              type="checkbox"
              bind:checked={detectGongTail}
              onchange={rebuildDetectedClips}
            />
            Keep the closing gong audible
          </label>
          <div class="tail-row">
            <label for="detectGongTailSec">Tail after each gong:</label>
            <input
              id="detectGongTailSec"
              bind:value={detectGongTailSec}
              onchange={rebuildDetectedClips}
              type="number"
              min="0"
              max="15"
              step="0.5"
              class="number-input"
              disabled={!detectGongTail}
            />
            <span>s</span>
          </div>
          <small
            >Clips end at the detected gong, which is reported slightly late; this
            adds a tail so the ring is not cut off (+2 s = 3:02 rounds). Turn off to
            cut exactly on the boundaries.</small
          >
        </div>

        <button
          class="detect-button"
          onclick={runDetection}
          disabled={detecting || transcoding || !selectedFile}
        >
          {detecting ? detectStatus || "Analyzing audio..." : "Detect rounds from audio"}
        </button>
        <small>Scans the audio for bell/gong onsets. Runs locally in your browser.</small>

        {#if onsets.length > 0}
          <div class="detect-results">
            <p>
              <strong>{onsets.length}</strong> onset{onsets.length === 1
                ? ""
                : "s"} kept{rejectedOnsets > 0
                ? ` (${rejectedOnsets} rejected as false positive${rejectedOnsets === 1 ? "" : "s"})`
                : ""},
              <strong>{detectedClips.length}</strong> candidate clip{detectedClips.length ===
              1
                ? ""
                : "s"}.
              {#if !breakPatternFound && detectedClips.length > 0}
                <em>No break found — every kept interval looks like a round.</em>
              {/if}
            </p>
            {#if detectedClips.length === 0}
              <p class="detect-warning">
                No complete round found: a round needs two gongs about
                {detectRoundLength}s apart (or a {detectBreakLength}s break).
                Lower the confidence threshold (or sensitivity) to find the
                missing gong, or adjust the expected lengths.
              </p>
            {:else}
              <label class="radio-label">
                <input
                  type="checkbox"
                  bind:checked={includeBreaks}
                  onchange={applyBreakInclusion}
                />
                Include breaks in output (round + pause)
              </label>
              <ul class="round-list">
                {#each detectedClips as clip, index}
                  <li>
                    <label class="radio-label">
                      <input type="checkbox" bind:checked={clip.enabled} />
                      <span
                        >{index + 1}: {formatTimestamp(clip.start)} → {formatTimestamp(
                          clip.end,
                        )} ({formatTimestamp(clip.end - clip.start)}){clip.isBreak
                          ? " — break"
                          : ""}</span
                      >
                    </label>
                  </li>
                {/each}
              </ul>
              <p class="detect-hint">
                Review the clips above, then click the <strong>Cut</strong> button
                below.
              </p>
            {/if}
          </div>
        {:else if !detecting}
          <p>Load FFmpeg, select a video, then click "Detect rounds from audio".</p>
        {/if}
      {/if}

      <button
        class="transcode-button"
        onclick={transcode}
        disabled={transcoding ||
          detecting ||
          !selectedFile ||
          (cutMode === "auto" &&
            detectedClips.filter((clip) => clip.enabled).length === 0)}
      >
        {transcoding
          ? "Processing..."
          : selectedFile
            ? cutMode === "auto"
              ? detectedClips.filter((clip) => clip.enabled).length > 0
                ? `Cut ${detectedClips.filter((clip) => clip.enabled).length} detected clips`
                : detectedClips.length > 0
                  ? "Select at least one clip"
                  : "Detect rounds first"
              : cutMode === "rounds"
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
          {#if cutMode === "auto"}
            Audio-detected intervals
          {:else if cutMode === "rounds"}
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

  {#if detecting}
    <p>{detectStatus || "Analyzing audio, please wait..."}</p>
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

  .detect-button {
    width: 100%;
    margin: 10px 0 4px 0;
  }

  .detect-results {
    margin: 15px 0;
    padding: 10px 15px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--info-bg);
    color: var(--info-text);
  }

  .round-list {
    list-style: none;
    padding: 0;
    margin: 10px 0 0 0;
    max-height: 260px;
    overflow-y: auto;
  }

  .round-list li {
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
  }

  .round-list .radio-label span {
    font-size: 13px;
  }

  .detect-warning {
    margin: 8px 0 0 0;
    font-size: 13px;
    color: var(--error-border);
  }

  .detect-hint {
    margin: 8px 0 0 0;
    font-size: 12px;
    color: var(--text-muted);
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

  .radio-label input[type="radio"],
  .radio-label input[type="checkbox"] {
    width: auto;
    margin: 0;
    accent-color: var(--accent);
  }

  .tail-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tail-row label {
    margin: 0;
    font-weight: normal;
  }

  .tail-row .number-input {
    width: 90px;
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
