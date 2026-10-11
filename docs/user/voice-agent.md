# Voice agent (beta)

Talk to T3 Code instead of typing. The voice agent can tell you what your
threads are doing, start new threads, send follow-ups, stop a running turn,
answer an agent's questions, and open a thread on screen. It also tells you
when a thread finishes or starts waiting on you. It runs on Gemini Live.

## Set it up

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. Turn on **Settings → General → Voice agent**.
3. Paste the key into **Gemini API key** and save it. The key is stored on the
   T3 Code server, not on your device; each voice session gets a short-lived
   token instead. A server without a saved key falls back to the
   `GEMINI_API_KEY` environment variable.

A microphone button then appears at the bottom of the sidebar. Under the same
setting you can pick the agent's voice and how quickly it speaks.

## Talk to it

Press the microphone button to start a session and press it again to end it.

- **Push to talk**: hold **Hold to talk** while you speak. Pressing it also
  cuts the agent off if it is speaking.
- **Hands-free**: the microphone stays open, and the agent answers when you
  pause. Use headphones so it does not hear itself.

## Good to know

- Threads the voice agent starts run in **Approval required** mode.
- It cannot approve an agent's permission requests. When a thread needs
  approval, ask it to open the thread and approve it yourself.
- Audio goes straight from your device to Google, not through the T3 Code
  server. Gemini usage is billed to the API key's Google account.
