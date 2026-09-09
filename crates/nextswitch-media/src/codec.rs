use audio_codec::{create_decoder, create_encoder, CodecType, Decoder, Encoder, Sample};

#[derive(Debug, Clone, Copy)]
pub enum MediaCodec {
    Pcmu,
    Pcma,
    G722,
    G729,
    Opus,
}

impl MediaCodec {
    pub fn create_encoder(&self) -> Box<dyn Encoder> {
        let codec_type = match self {
            MediaCodec::Pcmu => CodecType::PCMU,
            MediaCodec::Pcma => CodecType::PCMA,
            MediaCodec::G722 => CodecType::G722,
            MediaCodec::G729 => CodecType::G729,
            MediaCodec::Opus => CodecType::Opus,
        };
        create_encoder(codec_type)
    }

    pub fn create_decoder(&self) -> Box<dyn Decoder> {
        let codec_type = match self {
            MediaCodec::Pcmu => CodecType::PCMU,
            MediaCodec::Pcma => CodecType::PCMA,
            MediaCodec::G722 => CodecType::G722,
            MediaCodec::G729 => CodecType::G729,
            MediaCodec::Opus => CodecType::Opus,
        };
        create_decoder(codec_type)
    }

    pub fn encode(&self, samples: &[Sample]) -> Vec<u8> {
        let mut encoder = self.create_encoder();
        encoder.encode(samples)
    }

    pub fn decode(&self, data: &[u8]) -> Vec<Sample> {
        let mut decoder = self.create_decoder();
        decoder.decode(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcmu_encode_decode_roundtrip() {
        let codec = MediaCodec::Pcmu;
        let samples: Vec<Sample> = vec![0i16; 160];
        let encoded = codec.encode(&samples);
        assert!(!encoded.is_empty());
        let decoded = codec.decode(&encoded);
        assert_eq!(decoded.len(), 160);
    }
}
