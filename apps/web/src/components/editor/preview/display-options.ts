export const ASPECT_PRESETS: ReadonlyArray<{
  label: string;
  width: number;
  height: number;
}> = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "4:5", width: 1080, height: 1350 },
  { label: "4:3", width: 1440, height: 1080 },
  { label: "21:9", width: 2560, height: 1080 },
];

export const aspectLabelFor = (width: number, height: number): string => {
  const ratio = width / height;
  let closest = ASPECT_PRESETS[0];
  let smallestDelta = Infinity;
  for (const preset of ASPECT_PRESETS) {
    const delta = Math.abs(preset.width / preset.height - ratio);
    if (delta < smallestDelta) {
      smallestDelta = delta;
      closest = preset;
    }
  }
  return smallestDelta < 0.01 ? closest.label : "Custom";
};
