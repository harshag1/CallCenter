import { describe, expect, it } from "vitest";

import {
  LC4_DEV_FFMPEG_SHA256,
  LC4_DEV_OUTPUT_ROUTE_CALIBRATION_CONFIG_SHA256,
  LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256,
  LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256,
  createLc4DevelopmentLargeV3WhisperRuntime,
} from "../lc4-development-whisper-runtime";

const PATHS = Object.freeze({
  whisper_cli_path: "/opt/homebrew/Cellar/whisper-cpp/1.9.1/bin/whisper-cli",
  model_path:
    "/Users/harsha/.cache/hacc-benchmark/whisper/ggml-large-v3-turbo-q5_0.bin",
  ffmpeg_path: "/opt/homebrew/Cellar/ffmpeg@7/7.1.3_2/bin/ffmpeg",
});

describe("LC4-DEV pinned whisper.cpp runtime", () => {
  it("reconstructs the exact passing large-v3 output-route configuration", () => {
    const runtime = createLc4DevelopmentLargeV3WhisperRuntime(PATHS);
    expect(runtime.whisper_config_sha256).toBe(
      LC4_DEV_OUTPUT_ROUTE_CALIBRATION_CONFIG_SHA256,
    );
    expect(runtime.whisper_config.whisperCliSha256).toBe(
      LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256,
    );
    expect(runtime.whisper_config.modelSha256).toBe(
      LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256,
    );
    expect(runtime.whisper_config.ffmpegSha256).toBe(LC4_DEV_FFMPEG_SHA256);
    expect(Object.keys(runtime.contract)).not.toContain("provider");
    expect(Object.keys(runtime.contract)).not.toContain("arm");
  });
});
