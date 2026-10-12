Pod::Spec.new do |s|
  s.name = 'T3VoiceAudio'
  s.version = '0.0.0'
  s.summary = 'Full-duplex PCM audio for the T3 Code voice agent.'
  s.description = 'Echo-cancelled 16 kHz microphone capture and 24 kHz speech playback on one AVAudioEngine.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'MIT' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift'
  s.frameworks = 'AVFoundation', 'MediaPlayer', 'Speech'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
