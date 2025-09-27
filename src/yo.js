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

  onMount(() => {
    // Initialize FFmpeg instance
    ffmpeg = new FFmpeg();
  });

  onDestroy(() => {
    // Clean up all video URLs when component is destroyed
    videoSegments.forEach(segment => URL.revokeObjectURL(segment.url));
  });

  const load = async (): Promise<void> => {
    try {
      loading = true;
      error = "";
      
      // Use the latest stable version
      const baseURL: string = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
      
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
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
        workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript")
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
    if (file.type.startsWith('video/')) {
      selectedFile = file;
      console.log("Selected video:", file.name, "Size:", (file.size / 1024 / 1024).toFixed(2), "MB");
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

  const transcode = async (): Promise<void> => {
    if (!loaded) {
      error = "FFmpeg not loaded yet";
      return;
    }

    if (!selectedFile) {
      error = "Please select a video file first";
      return;
    }

    try {
      transcoding = true;
      error = "";
      
      console.log("Starting transcoding...");
      
      // Use the selected file instead of downloading from URL
      console.log("Processing selected file:", selectedFile.name);
      
      // Convert File to Uint8Array
      const arrayBuffer = await selectedFile.arrayBuffer();
      const videoData = new Uint8Array(arrayBuffer);
      
      // Get file extension from the selected file
      const fileExtension = selectedFile.name.split('.').pop()?.toLowerCase() || 'mp4';
      const inputFileName = `input.${fileExtension}`;
      
      console.log("Writing input file...");
      await ffmpeg.writeFile(inputFileName, videoData);
      
      console.log("Starting FFmpeg processing...");
      await ffmpeg.exec([
        "-i", inputFileName,
        "-f", "segment",
        "-segment_time", "3",
        "-c", "copy", // Copy streams without re-encoding for faster processing
        "-reset_timestamps", "1",
        "-map", "0",
        "output_%03d.mp4"
      ]);
      
      console.log("Reading output files...");
      
      // Clean up previous video segments
      videoSegments.forEach(segment => URL.revokeObjectURL(segment.url));
      videoSegments = [];
      
      // List all files to see what was created
      const files = await ffmpeg.listDir("/");
      console.log("Available files:", files);
      
      // Find all output files
      const outputFiles = files
        .map(file => file.name)
        .filter(name => name.startsWith("output_") && name.endsWith(".mp4"))
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
            url: url
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
      <button onclick={() => { error = ""; loaded = false; }}>Reset</button>
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
          <strong>Selected:</strong> {selectedFile.name} 
          ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
        </p>
      {/if}
    </div>

    {#if videoSegments.length > 0}
      <div class="video-grid">
        <h3>Video Segments ({videoSegments.length} total)</h3>
        {#each videoSegments as segment, index}
          <div class="video-segment">
            <h4>Segment {index + 1}: {segment.name}</h4>
            <video src={segment.url} controls style="max-width: 100%; height: auto;">
              Your browser does not support the video tag.
            </video>
          </div>
        {/each}
      </div>
    {:else}
      <p>No video segments loaded yet. Click the button below to process a video.</p>
    {/if}
    
    <br />
    <button onclick={transcode} disabled={transcoding || !selectedFile}>
      {transcoding ? "Processing..." : selectedFile ? "Split video into 3-second segments" : "Select a video file first"}
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
  
  .video-grid {
    margin: 20px 0;
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