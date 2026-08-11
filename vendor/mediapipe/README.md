# MediaPipe Tasks Vision (vendored)

These files are committed rather than fetched at runtime so the watch keeps
working offline and no request for them leaves the device. Nothing here is
StampNote's own work.

| File | Source | Version |
| --- | --- | --- |
| `vision_bundle.mjs`, `wasm/vision_wasm_internal.*` | npm `@mediapipe/tasks-vision` | 1.0.1 |
| `models/pose_landmarker_lite.task` | `storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/` | 1 |
| `models/efficientdet_lite0.tflite` | `storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/` | 1 |

Licensed under the Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0

Copyright 2022-2024 The MediaPipe Authors.

## Choices worth knowing

- The **lite** pose model and the **int8** detector are the smallest published
  builds, chosen because this runs on phones over a deployed site.
- Only the SIMD WebAssembly build is kept. The no-SIMD fallback is another
  10.5 MB and every browser that can run this app has had SIMD for years; a
  device without it falls back to StampNote's own detector instead.
- To update, replace the files from the same sources and check the model's
  landmark order still matches `pose-model.js`.
