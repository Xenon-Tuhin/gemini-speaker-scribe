import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  AppBar,
  Box,
  Button,
  Chip,
  Container,
  CssBaseline,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ThemeProvider,
  Toolbar,
  Typography,
  createTheme,
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DownloadIcon from "@mui/icons-material/Download";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import KeyIcon from "@mui/icons-material/Key";
import DescriptionIcon from "@mui/icons-material/Description";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Podcast to SRT by ALI" },
      {
        name: "description",
        content:
          "Upload a podcast and get a speaker-labeled transcript with timestamps powered by Gemini. Export JSON, CSV, TXT, or SRT.",
      },
    ],
  }),
  component: Page,
});

type Segment = {
  speaker: "Xenon" | "Silica" | string;
  start_ms: number;
  end_ms: number;
  text: string;
};

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#7c9cff" },
    secondary: { main: "#ff8bd1" },
    background: { default: "#0b0d12", paper: "#12151d" },
  },
  shape: { borderRadius: 12 },
  typography: { fontFamily: "'Inter', system-ui, sans-serif" },
});

const MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (recommended)" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (higher quality)" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash (faster)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (fallback)" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (fallback)" },
];

function fmtTime(ms: number, srt = false) {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msR = total % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return srt
    ? `${pad(h)}:${pad(m)}:${pad(s)},${pad(msR, 3)}`
    : `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msR, 3)}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result as string;
      resolve(s.split(",")[1] ?? "");
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const SYSTEM_PROMPT = `Analyze this podcast audio.

There are two speakers:
- Speaker 1: Name: Xenon, Gender: Male
- Speaker 2: Name: Silica, Gender: Female

Generate a complete dialogue timeline.

Requirements:
- Detect speaker changes.
- Return start timestamp (start_ms in milliseconds).
- Return end timestamp (end_ms in milliseconds).
- Return speaker name ("Xenon" or "Silica").
- Return spoken text.
- Maintain chronological order.

Output JSON only, matching this schema:
{ "segments": [ { "speaker": "Xenon", "start_ms": 0, "end_ms": 8500, "text": "..." } ] }`;

function Page() {
  const [apiKey, setApiKey] = useState<string>(
    () => (typeof window !== "undefined" && localStorage.getItem("gemini_api_key")) || "",
  );
  const [model, setModel] = useState(MODELS[0].id);
  const [audio, setAudio] = useState<File | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState<"idle" | "processing" | "done" | "error">("idle");
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string>("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const saveKey = (v: string) => {
    setApiKey(v);
    try {
      localStorage.setItem("gemini_api_key", v);
    } catch {}
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setAudio(f);
  }, []);

  const process = async () => {
    if (!apiKey) return setError("Please enter your Gemini API key.");
    if (!audio) return setError("Please upload an audio file.");
    setError("");
    setSegments([]);
    setStatus("processing");
    setStatusText("Encoding audio…");

    try {
      const b64 = await fileToBase64(audio);
      const mime = audio.type || "audio/mpeg";

      setStatusText(`Sending to ${model}…`);

      const parts: Array<Record<string, unknown>> = [
        { text: SYSTEM_PROMPT },
      ];
      if (transcript.trim()) {
        parts.push({
          text: `Reference transcript/script (use for accuracy, but timestamps must come from the audio):\n\n${transcript}`,
        });
      }
      parts.push({ inlineData: { mimeType: mime, data: b64 } });

      const body = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              segments: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    speaker: { type: "STRING" },
                    start_ms: { type: "INTEGER" },
                    end_ms: { type: "INTEGER" },
                    text: { type: "STRING" },
                  },
                  required: ["speaker", "start_ms", "end_ms", "text"],
                },
              },
            },
            required: ["segments"],
          },
        },
      };

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
        apiKey,
      )}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Gemini API ${res.status}: ${t}`);
      }
      const data = await res.json();
      const text: string =
        data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
      if (!text) throw new Error("Empty response from Gemini.");

      const parsed = JSON.parse(text) as { segments: Segment[] };
      const segs = (parsed.segments ?? []).sort((a, b) => a.start_ms - b.start_ms);
      setSegments(segs);
      setStatus("done");
      setStatusText(`Done — ${segs.length} segments`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus("error");
      setStatusText("Failed");
    }
  };

  const exports = useMemo(() => {
    const json = JSON.stringify({ segments }, null, 2);
    const csv = [
      "speaker,start_ms,end_ms,text",
      ...segments.map(
        (s) =>
          `${s.speaker},${s.start_ms},${s.end_ms},"${(s.text ?? "").replace(/"/g, '""')}"`,
      ),
    ].join("\n");
    const txt = segments
      .map((s) => `[${fmtTime(s.start_ms)} - ${fmtTime(s.end_ms)}] ${s.speaker}: ${s.text}`)
      .join("\n");
    const srt = segments
      .map(
        (s, i) =>
          `${i + 1}\n${fmtTime(s.start_ms, true)} --> ${fmtTime(s.end_ms, true)}\n${s.speaker}: ${s.text}\n`,
      )
      .join("\n");
    return { json, csv, txt, srt };
  }, [segments]);

  const download = (name: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const base = audio ? audio.name.replace(/\.[^.]+$/, "") : "podcast";

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar>
          <GraphicEqIcon sx={{ mr: 1, color: "primary.main" }} />
          <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1 }}>
            Podcast Speaker Timestamps
          </Typography>
          <Chip label="Gemini" size="small" color="primary" variant="outlined" />
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack spacing={3}>
          <Paper sx={{ p: 3 }}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{}}>
              <TextField
                fullWidth
                label="Gemini API Key"
                type="password"
                value={apiKey}
                onChange={(e) => saveKey(e.target.value)}
                helperText="Stored only in your browser (localStorage)."
                slotProps={{ input: { startAdornment: <KeyIcon sx={{ mr: 1, opacity: 0.6 }} /> } }}
              />
              <TextField
                select
                label="Model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                sx={{ minWidth: 280 }}
              >
                {MODELS.map((m) => (
                  <MenuItem key={m.id} value={m.id}>
                    {m.label}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          </Paper>

          <Paper
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            sx={{
              p: 5,
              textAlign: "center",
              border: "2px dashed",
              borderColor: dragOver ? "primary.main" : "divider",
              bgcolor: dragOver ? "action.hover" : "background.paper",
              cursor: "pointer",
              transition: "0.15s",
            }}
            onClick={() => fileInput.current?.click()}
          >
            <input
              ref={fileInput}
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/m4a,.mp3,.wav,.m4a"
              hidden
              onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
            />
            <CloudUploadIcon sx={{ fontSize: 48, color: "primary.main", mb: 1 }} />
            <Typography variant="h6">
              {audio ? audio.name : "Drop podcast audio here or click to browse"}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              MP3 · WAV · M4A — processed entirely in your browser via Gemini API
            </Typography>
          </Paper>

          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: "center" }}>
              <DescriptionIcon fontSize="small" />
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Optional transcript / script
              </Typography>
            </Stack>
            <TextField
              multiline
              minRows={4}
              maxRows={10}
              fullWidth
              placeholder="Paste an optional reference transcript to improve accuracy…"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
          </Paper>

          <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
            <Button
              variant="contained"
              size="large"
              disabled={status === "processing" || !audio || !apiKey}
              onClick={process}
            >
              {status === "processing" ? "Processing…" : "Generate Timeline"}
            </Button>
            <Stack direction="row" spacing={1}>
              <Chip label="Xenon (Male)" sx={{ bgcolor: "#1e2a4a", color: "#a9c2ff" }} />
              <Chip label="Silica (Female)" sx={{ bgcolor: "#3a1e33", color: "#ffb3df" }} />
            </Stack>
          </Stack>

          {status === "processing" && (
            <Paper sx={{ p: 2 }}>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {statusText}
              </Typography>
              <LinearProgress />
            </Paper>
          )}
          {error && (
            <Paper sx={{ p: 2, borderLeft: 4, borderColor: "error.main" }}>
              <Typography variant="body2" color="error" sx={{ whiteSpace: "pre-wrap" }}>
                {error}
              </Typography>
            </Paper>
          )}

          {segments.length > 0 && (
            <Paper sx={{ p: 3 }}>
              <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: "center" }}>
                <Typography variant="h6" sx={{ flexGrow: 1 }}>
                  Dialogue Timeline
                </Typography>
                <Button
                  size="small"
                  startIcon={<DownloadIcon />}
                  onClick={() => download(`${base}.json`, exports.json, "application/json")}
                >
                  JSON
                </Button>
                <Button
                  size="small"
                  startIcon={<DownloadIcon />}
                  onClick={() => download(`${base}.csv`, exports.csv, "text/csv")}
                >
                  CSV
                </Button>
                <Button
                  size="small"
                  startIcon={<DownloadIcon />}
                  onClick={() => download(`${base}.txt`, exports.txt, "text/plain")}
                >
                  TXT
                </Button>
                <Button
                  size="small"
                  startIcon={<DownloadIcon />}
                  onClick={() => download(`${base}.srt`, exports.srt, "application/x-subrip")}
                >
                  SRT
                </Button>
              </Stack>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell width={110}>Start</TableCell>
                      <TableCell width={110}>End</TableCell>
                      <TableCell width={110}>Speaker</TableCell>
                      <TableCell>Text</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {segments.map((s, i) => (
                      <TableRow key={i} hover>
                        <TableCell sx={{ fontFamily: "monospace" }}>{fmtTime(s.start_ms)}</TableCell>
                        <TableCell sx={{ fontFamily: "monospace" }}>{fmtTime(s.end_ms)}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={s.speaker}
                            sx={{
                              bgcolor: s.speaker === "Silica" ? "#3a1e33" : "#1e2a4a",
                              color: s.speaker === "Silica" ? "#ffb3df" : "#a9c2ff",
                            }}
                          />
                        </TableCell>
                        <TableCell>{s.text}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          )}

          <Box sx={{ opacity: 0.6, textAlign: "center", pt: 2 }}>
            <Typography variant="caption">
              100% client-side. Your API key and audio never touch our servers.
            </Typography>
            <IconButton size="small" disabled>
              <GraphicEqIcon fontSize="small" />
            </IconButton>
          </Box>
        </Stack>
      </Container>
    </ThemeProvider>
  );
}
