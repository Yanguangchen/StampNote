# Face recognition model provenance

StampNote vendors only the browser bundle and face-recognition weights from
`@vladmandic/face-api` 1.7.15. They were copied from the published npm package;
the upstream source is <https://github.com/vladmandic/face-api> and the included
license is in `LICENSE`.

Included files and SHA-256 digests:

- `face-api.esm.js`: `14f0e9813f6d9f14a9cdafb6543a74835ebb13085090e2942310a7a737f55d9a`
- `model/face_recognition_model-weights_manifest.json`: `cbaffa501b0b9275a12b63357a6843e7e30c054e1c9151e1a5f879b26e32986b`
- `model/face_recognition_model.bin`: `b413e420d6840b2775fba32008db6f3cddb07d485967fb42cfcf379c16a8c589`

The face detector and landmark models from this package are intentionally not
included. StampNote reuses the MediaPipe face landmarks already needed by the
camera overlay, aligns a temporary 150 × 150 crop, computes its descriptor, and
then clears the crop. No face data is sent to the model publisher.
