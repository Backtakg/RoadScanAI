# RoadScan AI

A simple zero-cost browser-first pothole inspection tool.

## What it does

- Live phone camera inspection
- Recorded video inspection
- Real-time pothole bounding boxes
- Unique pothole counting with lightweight IoU tracking
- AI confidence bands: High / Medium / Low
- Simple visual severity estimate: Low / Medium / High
- Pothole evidence images captured from the processed frame
- Detection timestamp
- Browser GPS coordinates when permission is available
- Start → finish inspection route on an OpenStreetMap/Leaflet map
- One-click PDF report after stopping an inspection
- No paid backend and no video upload server

## How the AI works

The app loads a pretrained YOLOv8 pothole ONNX model in the browser using ONNX Runtime Web. Video frames are processed locally; detections are then tracked so the same pothole appearing across many frames is counted once.

Model source: `peterhdd/pothole-detection-yolov8` on Hugging Face. Review the model and dataset licenses before commercial use.

## Important accuracy note

This is an MVP detector, not a certified road-condition measurement system. Severity is a visual estimate derived from the pothole's apparent frame area. Night, rain, fog, camera angle, motion blur and unusual road surfaces can reduce detection accuracy. A later training/validation phase should use representative Nepal road imagery and held-out day/night/rain/fog test sets.

## Run

Open the deployed GitHub Pages site, allow camera/location access, and start an inspection. The app can also be opened locally as a static site.

No API key, database, paid cloud service or server is required for the MVP.
