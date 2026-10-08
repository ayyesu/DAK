Pod::Spec.new do |s|
  s.name           = 'DakNativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for DAK mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = 'DAK'
  s.homepage       = 'https://dak.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
