Pod::Spec.new do |s|
  s.name = 'T3VpnTunnel'
  s.version = '0.0.0'
  s.summary = 'In-app GlobalProtect tunnel for T3 Code mobile.'
  s.description = 'libopenconnect + lwIP running inside the app, exposing a localhost forward to one host.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'LGPL-2.1 (libopenconnect), Apache-2.0 (OpenSSL), BSD-3-Clause (lwIP)' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift'
  s.vendored_frameworks = 'Vendor/OCCore.xcframework'
  s.libraries = 'xml2', 'z', 'iconv'
  s.frameworks = 'NetworkExtension'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
