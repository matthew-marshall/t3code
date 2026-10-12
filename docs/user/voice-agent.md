# Voice agent (beta)

Talk to T3 Code instead of typing. The voice agent can tell you what your
threads are doing, read you what an agent said, start new threads, send
follow-ups, stop a running turn, answer an agent's questions, approve or deny
its requests, and open a thread on screen. It also tells you when a thread
finishes or starts waiting on you. It runs on Gemini Live, and works with
every environment you are connected to, with nothing to set up on them.

## Set it up

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. Turn on the voice agent and add the key:
   - **Web and desktop**: **Settings → General → Voice agent**, then paste the
     key into **Gemini API key**.
   - **iPhone and iPad**: **Settings → Voice Agent**, then **Add key**.

The key stays on that device. The desktop app and the iOS app keep it in the
system keychain; a browser keeps it in its own storage. It is only sent to
Google, which gives each voice connection a short-lived token. Each device
needs the key once. The same key powers dictation that removes filler words; see
[Dictation on web and desktop](composer.md#dictation-on-web-and-desktop) and
[Voice input on iPhone](composer.md#voice-input-on-iphone).

The same setting picks the agent's voice and how quickly it speaks. On web and
desktop a microphone button then appears at the bottom of the sidebar; on iOS
a waveform button appears at the top of the thread list.

## Talk to it

Press the button to start a session and press it again to end it.

- **Push to talk**: hold **Hold to talk** while you speak. Pressing it also
  cuts the agent off if it is speaking.
- **Hands-free**: the microphone stays open, and the agent answers when you
  pause. In a browser, use headphones so it does not hear itself. The iOS app
  cancels its own voice, so hands-free works on the speaker.

On iOS the conversation keeps going with the screen locked, so you can use it
while driving or running. It uses a connected car or headset microphone in the
order set under **Settings → Microphone**, and picks again when one connects
or disconnects.

## Good to know

- Before it approves or denies a request, starts a thread, or stops one, the
  agent says what it is about to do and waits for you to say yes.
- Threads the voice agent starts run in **Approval required** mode, on the
  project's default model. Like the new-task screen, they start in a new
  worktree or in the project checkout according to the project's setting; the
  agent tells you which before it starts, and you can ask for the other.
- It does not manage repositories, branches or pull requests; do those in the
  app.
- Audio goes straight from your device to Google, not through any T3 Code
  server. Gemini usage is billed to the API key's Google account.
