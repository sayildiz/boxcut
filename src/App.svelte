<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { FFmpeg } from "@ffmpeg/ffmpeg";
  import { fetchFile, toBlobURL } from "@ffmpeg/util";

  let loaded = $state<boolean>(false);
  let loading = $state<boolean>(false);
  let transcoding = $state<boolean>(false);
  let error = $state<string>("");
  let ffmpeg: FFmpeg;
  let videoSegments = $state<Array<{ name: string; url: string }>>([]);
  let selectedFile = $state<File | null>(null);
  let fileInputElement = $state<HTMLInputElement>();
  let dragOver = $state<boolean>(false);
  let messageElement = $state<HTMLParagraphElement>();

  // New state variables for start time and segment length
  let startTime = $state<string>("00:00:00");
  let segmentLength = $state<number>(3);

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
    if (segmentLength <= 0) {
      error = "Segment length must be greater than 0";
      return;
    }

    try {
      transcoding = true;
      error = "";

      console.log("Starting transcoding...");
      console.log(
        `Start time: ${startTime}, Segment length: ${segmentLength}s`,
      );

      // Use the selected file instead of downloading from URL
      console.log("Processing selected file:", selectedFile.name);

      // Convert File to Uint8Array
      const arrayBuffer = await selectedFile.arrayBuffer();
      const videoData = new Uint8Array(arrayBuffer);

      console.log(selectedFile);
      // Get file extension from the selected file
      const fileExtension =
        selectedFile.name.split(".").pop()?.toLowerCase() || "mp4";
      const inputFileName = `input.${fileExtension}`;
      console.log("Input file: " + inputFileName);

      console.log("Writing input file...");
      await ffmpeg.writeFile(inputFileName, videoData);

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
        segmentLength.toString(), // Use custom segment length
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

      console.log("Reading output files...");

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

      // Read all segments and create URLs
      for (const fileName of outputFiles) {
        try {
          const data = await ffmpeg.readFile(fileName);
          const blob = new Blob([data], { type: "video/mp4" });
          const url = URL.createObjectURL(blob);

          videoSegments.push({
            name: fileName,
            url: url,
          });
        } catch (err) {
          console.warn(`Failed to read ${fileName}:`, err);
        }
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
    </div>

    {#if videoSegments.length > 0}
      <div class="video-grid">
        <h3>Video Segments ({videoSegments.length} total)</h3>
        <p class="segment-info">
          Started at: <strong>{startTime}</strong> | Segment length:
          <strong>{segmentLength}s</strong>
        </p>
        {#each videoSegments as segment, index}
          <div class="video-segment">
            <h4>Segment {index + 1}: {segment.name}</h4>
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

    <br />
    <button onclick={transcode} disabled={transcoding || !selectedFile}>
      {transcoding
        ? "Processing..."
        : selectedFile
          ? `Split video into ${segmentLength}s segments starting at ${startTime}`
          : "Select a video file first"}
    </button>
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
    background: #fee;
    border: 1px solid #fcc;
    padding: 10px;
    margin: 10px 0;
    border-radius: 4px;
  }

  button {
    padding: 10px 20px;
    margin: 5px;
    border: none;
    background: #007cba;
    color: white;
    border-radius: 4px;
    cursor: pointer;
  }

  button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }

  button:hover:not(:disabled) {
    background: #005a87;
  }

  .file-input-section {
    margin: 20px 0;
    padding: 20px;
    border: 2px dashed #ddd;
    border-radius: 8px;
    background: #fafafa;
    text-align: center;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .file-input-section:hover,
  .file-input-section.drag-over {
    border-color: #007cba;
    background: #f0f8ff;
  }

  .file-input {
    margin: 10px 0;
    padding: 5px;
  }

  .file-info {
    color: #666;
    font-size: 14px;
    margin: 10px 0;
  }

  .controls-section {
    margin: 20px 0;
    padding: 20px;
    border: 1px solid #ddd;
    border-radius: 8px;
    background: #f8f9fa;
  }

  .controls-section h3 {
    margin: 0 0 15px 0;
    color: #333;
  }

  .input-group {
    margin: 15px 0;
  }

  .input-group label {
    display: block;
    margin-bottom: 5px;
    font-weight: bold;
    color: #555;
  }

  .time-input,
  .number-input {
    width: 200px;
    padding: 8px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
  }

  .time-input:focus,
  .number-input:focus {
    outline: none;
    border-color: #007cba;
    box-shadow: 0 0 0 2px rgba(0, 124, 186, 0.1);
  }

  .input-group small {
    display: block;
    margin-top: 5px;
    color: #666;
    font-size: 12px;
  }

  .video-grid {
    margin: 20px 0;
  }

  .segment-info {
    background: #e9f5ff;
    padding: 10px;
    border-radius: 4px;
    margin: 10px 0;
    font-size: 14px;
    color: #2c5282;
  }

  .video-segment {
    margin: 15px 0;
    padding: 15px;
    border: 1px solid #ddd;
    border-radius: 8px;
    background: #f9f9f9;
  }

  .video-segment h4 {
    margin: 0 0 10px 0;
    color: #333;
    font-size: 14px;
  }
</style>
