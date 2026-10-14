# Voice agent (beta)

Talk to T3 Code instead of typing. The voice agent can tell you what your
threads are doing, read you what an agent said, start new threads, send
follow-ups, stop a running turn, answer an agent's questions, approve or deny
its requests, and open a thread on screen. It also tells you when a thread
finishes or starts waiting on you. It runs on Gemini Live or OpenAI Realtime,
and works with every environment you are connected to, with nothing to set up
on them.

## Set it up

1. Get an API key for the provider you want: Gemini from
   [Google AI Studio](https://aistudio.google.com/apikey), or OpenAI from the
   [OpenAI platform](https://platform.openai.com/api-keys).
2. Turn on the voice agent, pick the provider, and add its key:
   - **Web and desktop**: **Settings → General → Voice agent**.
   - **iPhone and iPad**: **Settings → Voice Agent**, then **Add key**.

Each key stays on that device. The desktop app and the iOS app keep it in the
system keychain; a browser keeps it in its own storage. It is only sent to its
provider, which gives each voice connection a short-lived credential. Each
device needs a key once. You can save both and switch providers to compare
them. The Gemini key also powers dictation that removes filler words; see
[Dictation on web and desktop](composer.md#dictation-on-web-and-desktop) and
[Voice input on iPhone](composer.md#voice-input-on-iphone).

The same setting picks the agent's voice, from the provider's own voices, and
how quickly it speaks. On web and desktop a microphone button then appears at
the bottom of the sidebar; on iOS a waveform button appears at the top of the
thread list.

## Talk to it

Press the button to start a session and press it again to end it. On iPhone,
the **Drive** tab in the bottom bar is made for a phone in a car mount: one
large button starts voice, then becomes the talk button. Hold it while you
speak, or tap it to talk hands-off and tap again to send; in hands-free mode it
mutes the microphone. A small ✕ at the top ends the session.

- **Push to talk**: hold **Hold to talk** while you speak. Pressing it also
  cuts the agent off if it is speaking.
- **Hands-free**: the microphone stays open, and the agent answers when you
  pause. In a browser, use headphones so it does not hear itself. The iOS app
  cancels its own voice, so hands-free works on the speaker.

You can also ask the agent to stop listening, which switches to push to talk,
or to listen again.

On iOS, short sounds tell you what is happening when nobody is talking: a blip
when the agent uses a tool, a soft tick every second or two while a slow tool
runs or the agent is working out a reply, and a two-note tone when the
connection drops (rising again when it is back). If you finish speaking and hear
neither a reply nor ticks, the agent did not hear you. Turn them off under
**Settings → Voice Agent → Sound cues**.

On iOS the conversation keeps going with the screen locked, so you can use it
while driving or running. With CarPlay it always uses the car's microphone, so
you hear the agent through the car. Otherwise it uses a connected headset or
car microphone in the order set under **Settings → Microphone**. It picks again
when one connects or disconnects.

## Dictate

When you want to say something long, dictate instead of talking to the agent:
press **Dictate** on the iPhone **Drive** tab, or ask the agent to start
dictation. A chime marks the start. Talk for as long as you like; the agent does
not hear you, does not speak, and holds its updates. To stop, press **Finish
dictation**, press play/pause on your steering wheel or headphones, or say "stop
dictation" and pause; a second chime plays.

The agent then gets the transcript and asks what to do with it, unless that is
already clear. It can send a dictation as a message or start a thread with it
without retyping it. Ask for "the latest dictation" or one by number.

**Settings → Voice Agent → Dictation** picks how it is transcribed:

- **Gemini**: transcribed at the end by Gemini 3.5 Transcribe, which drops
  filler words. Uses the Gemini key.
- **On device**: Apple's speech recognition, free and offline but less accurate.

Either way, Apple's on-device speech listens for the stop phrase. "End
dictation" works too, but "end" is easily misheard as "and". The first use may
download Apple's speech model.

## Read aloud

To hear a message itself rather than the agent's summary, ask it to "read
that message" or to read part of one ("read the conclusion", "read the data
table"). After a chime, a different voice reads it word for word, using Gemini
text to speech and the Gemini key. Tables are read row by row and code blocks
are announced; ask for the code if you want it read out. The agent stays quiet
and its updates wait until reading ends.

Start talking and reading pauses. Ask to resume, go back a few sentences, read
a paragraph again, or jump to another part. The Drive tab shows where it is,
with Pause and Stop. You can also have a dictation read back.

## Feedback for the logs

To note something about the app while it is fresh, say "dictate feedback for the
logs": it records like a dictation and is saved beside the session log of what
just happened, without the agent acting on it. Say "flag that" to mark the
moment with a one-line note instead. On iPhone, feedback is also kept in its own
file that outlasts the session logs.

## Good to know

- Before it approves or denies a request, starts a thread, or stops one, the
  agent says what it is about to do and waits for you to say yes.
- Threads the voice agent starts get the same permissions and model as threads
  you start in the app (Default permissions under New threads in Settings,
  usually **Full access**). Ask it to change a thread's permissions, for
  example "let that thread run without asking". Like the new-task screen, they start in a new
  worktree or in the project checkout according to the project's setting, and
  you can ask for the other or for a new worktree off a branch you name. Before
  it starts one, the agent reads back the project, the task and where it runs,
  and waits for you to say yes.
- It does not manage repositories, branches or pull requests; do those in the
  app.
- With Gemini, ask it to look something up and it searches the web with Google
  Search. OpenAI Realtime has no web search.
- Audio goes straight from your device to the provider, not through any T3
  Code server. Usage is billed to the API key's account.
