# ASR Websocket samples

## OpenAPI documention is available 
Go [there](https://asr-lvl.voxist.com/api-documentation/).

## Account @voxist required.
[Contact us](mailto:contact@voxist.com) if interested.

## Dependencies

This module requires you to install [SoX](http://sox.sourceforge.net/) and it must be available in your \$PATH.

### For Linux

```
sudo apt-get install sox libsox-fmt-all
```

### For MacOS

```
brew install sox
```

### For Windows

[Download the binaries](http://sourceforge.net/projects/sox/files/latest/downlo

## install

```
yarn
```

## asr-file.js
Wave file has to be 16kHz and in french. You can edit `asr-file.js` for more settings
```
node asr-file.js <USER> <PASSWORD> <WAV>
```

## asr-mic.js (Experimental)
```
node asr-mic.js <USER> <PASSWORD>
```
WWhen recorder is ready, microphone audio will be transcribed.