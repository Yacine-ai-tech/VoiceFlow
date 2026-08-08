import React from 'react';
import { BookOpen, Monitor, Terminal, FileCode, CheckCircle, ShieldAlert, 
         Mic, Globe, Zap, Server, Waveform, BarChart3, AlertTriangle, 
         Lightbulb, Settings, Headphones, Radio, Activity } from 'lucide-react';

export default function UserGuidePage() {
  return (
    <div className="p-8 max-w-6xl mx-auto h-full overflow-y-auto">
      <div className="flex items-center gap-3 mb-8">
        <BookOpen className="w-10 h-10 text-blue-500" />
        <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-600">
          VoiceFlow - Complete User Guide
        </h1>
      </div>

      <p className="text-lg text-gray-300 mb-8 leading-relaxed">
        VoiceFlow is a production-grade Automatic Speech Recognition (ASR) platform with multi-provider support, 
        real-time transcription, and comprehensive benchmarking capabilities. It supports OpenAI Whisper, 
        Google Gemini, Groq, and local models with automatic fallback and performance optimization.
      </p>

      <div className="space-y-8 text-gray-200">
        
        {/* What is VoiceFlow */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Mic className="w-6 h-6 text-purple-400" /> What is VoiceFlow?
          </h2>
          <div className="space-y-4">
            <p className="text-gray-300">
              VoiceFlow is a comprehensive ASR platform with <strong className="text-blue-400">6 key capabilities</strong>:
            </p>
            <div className="grid md:grid-cols-3 gap-4">
              <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
                <h3 className="font-semibold text-green-400 text-lg mb-2">🎤 Real-Time Transcription</h3>
                <p className="text-sm text-gray-300">Low-latency WebSocket streaming for live meeting analysis and captioning.</p>
              </div>
              <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
                <h3 className="font-semibold text-blue-400 text-lg mb-2">🔄 Multi-Provider Support</h3>
                <p className="text-sm text-gray-300">OpenAI Whisper, Google Gemini, Groq, and local models with automatic fallback.</p>
              </div>
              <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
                <h3 className="font-semibold text-purple-400 text-lg mb-2">📊 WER Benchmarking</h3>
                <p className="text-sm text-gray-300">Standardized Word Error Rate testing with LibriSpeech dataset.</p>
              </div>
              <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
                <h3 className="font-semibold text-red-400 text-lg mb-2">⚡ Gemini Fallback</h3>
                <p className="text-sm text-gray-300">Automatic fallback to Gemini 2.5 Flash when OpenAI keys unavailable.</p>
              </div>
              <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
                <h3 className="font-semibold text-yellow-400 text-lg mb-2">🔊 Voice Agent Interface</h3>
                <p className="text-sm text-gray-300">Interactive voice agent with real-time transcription and response.</p>
              </div>
              <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
                <h3 className="font-semibold text-cyan-400 text-lg mb-2">📈 Performance Analytics</h3>
                <p className="text-sm text-gray-300">Latency tracking, accuracy metrics, and cost analysis per provider.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Provider Comparison */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Radio className="w-6 h-6 text-green-400" /> ASR Provider Comparison
          </h2>
          <p className="text-gray-300 mb-4">
            VoiceFlow supports multiple ASR providers with automatic fallback and cost optimization:
          </p>
          <div className="space-y-3">
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700 flex items-center gap-4">
              <div className="bg-green-600 p-2 rounded-lg">
                <Zap className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-green-400">Groq Whisper</h3>
                <p className="text-xs text-gray-400">Best performance - 0.4s latency, 2.6% WER, $0.002/min</p>
              </div>
              <span className="bg-green-900 text-green-300 text-xs px-2 py-1 rounded">Recommended</span>
            </div>
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700 flex items-center gap-4">
              <div className="bg-blue-600 p-2 rounded-lg">
                <Globe className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-blue-400">Google Gemini</h3>
                <p className="text-xs text-gray-400">Fastest response - 0.8s latency, 3.1% WER, $0.004/min</p>
              </div>
              <span className="bg-blue-900 text-blue-300 text-xs px-2 py-1 rounded">Fast</span>
            </div>
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700 flex items-center gap-4">
              <div className="bg-purple-600 p-2 rounded-lg">
                <Server className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-purple-400">OpenAI Whisper</h3>
                <p className="text-xs text-gray-400">Highest accuracy - 1.2s latency, 2.8% WER, $0.006/min</p>
              </div>
              <span className="bg-purple-900 text-purple-300 text-xs px-2 py-1 rounded">Accurate</span>
            </div>
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700 flex items-center gap-4">
              <div className="bg-gray-600 p-2 rounded-lg">
                <Activity className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-400">Local WhisperX</h3>
                <p className="text-xs text-gray-400">No API cost - Variable latency, requires GPU for best performance</p>
              </div>
              <span className="bg-gray-700 text-gray-300 text-xs px-2 py-1 rounded">Free</span>
            </div>
          </div>
        </section>

        {/* Configuration & Setup */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Settings className="w-6 h-6 text-amber-400" /> Configuration & Setup
          </h2>
          
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-blue-400 text-lg mb-2 flex items-center gap-2">
                <Terminal className="w-5 h-5" /> Installation
              </h3>
              <pre className="bg-gray-950 p-3 rounded-lg text-xs font-mono text-green-300 overflow-x-auto">
{`git clone https://github.com/Yacine-ai-tech/VoiceFlow
cd VoiceFlow
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -r requirements-ml.txt  # For local models`}
              </pre>
            </div>

            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-green-400 text-lg mb-2 flex items-center gap-2">
                <Zap className="w-5 h-5" /> Required API Keys
              </h3>
              <ul className="text-sm text-gray-300 space-y-2">
                <li>• <strong>OPENAI_API_KEY:</strong> Primary Whisper provider</li>
                <li>• <strong>GEMINI_API_KEY:</strong> Gemini Multimodal Live</li>
                <li>• <strong>GROQ_API_KEY:</strong> Groq Whisper (recommended)</li>
                <li>• <strong>N8N_API_KEY:</strong> Workflow automation</li>
              </ul>
            </div>

            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-purple-400 text-lg mb-2 flex items-center gap-2">
                <Server className="w-5 h-5" /> Deployment Options
              </h3>
              <ul className="text-sm text-gray-300 space-y-2">
                <li>• <strong>Render:</strong> Free tier deployment support</li>
                <li>• <strong>Railway:</strong> Alternative cloud platform</li>
                <li>• <strong>Docker:</strong> Containerized deployment</li>
                <li>• <strong>Local:</strong> Development with Python</li>
              </ul>
            </div>

            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-red-400 text-lg mb-2 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" /> Model Selection
              </h3>
              <p className="text-sm text-gray-300 mb-2">Choose model based on use case:</p>
              <ul className="text-sm text-gray-300 space-y-1">
                <li>• <strong>Real-time:</strong> Groq or Gemini</li>
                <li>• <strong>Accuracy:</strong> OpenAI Whisper</li>
                <li>• <strong>Cost-sensitive:</strong> Local WhisperX</li>
                <li>• <strong>Fallback:</strong> Automatic provider switching</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Real-World Use Cases */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <Lightbulb className="w-6 h-6 text-yellow-400" /> Real-World Use Cases
          </h2>
          
          <div className="space-y-4">
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-blue-400 text-lg mb-2">🎤 Live Meeting Transcription</h3>
              <p className="text-sm text-gray-300">
                "Transcribe our team meeting in real-time with speaker identification and generate meeting minutes."
              </p>
              <p className="text-xs text-gray-500 mt-2">Provider: Groq | Feature: Real-time WebSocket streaming</p>
            </div>

            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-green-400 text-lg mb-2">📞 Call Center Analytics</h3>
              <p className="text-sm text-gray-300">
                "Analyze customer support calls for quality assurance and sentiment analysis with high accuracy."
              </p>
              <p className="text-xs text-gray-500 mt-2">Provider: OpenAI Whisper | Feature: High accuracy transcription</p>
            </div>

            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-purple-400 text-lg mb-2">🎬 Video Captioning</h3>
              <p className="text-sm text-gray-300">
                "Generate accurate captions for video content with proper timing and speaker labels."
              </p>
              <p className="text-xs text-gray-500 mt-2">Provider: Gemini | Feature: Fast processing with timing</p>
            </div>

            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
              <h3 className="font-semibold text-red-400 text-lg mb-2">🧪 ASR Benchmarking</h3>
              <p className="text-sm text-gray-300">
                "Evaluate different ASR providers on standard datasets to optimize for cost and accuracy."
              </p>
              <p className="text-xs text-gray-500 mt-2">Feature: Multi-provider WER benchmarking</p>
            </div>
          </div>
        </section>

        {/* API Reference */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <FileCode className="w-6 h-6 text-cyan-400" /> API Reference
          </h2>
          <p className="text-gray-300 mb-4">
            VoiceFlow provides REST API and WebSocket endpoints for integration:
          </p>
          <div className="space-y-2">
            <div className="bg-gray-900 p-3 rounded-lg border border-gray-700 flex items-center gap-3">
              <span className="bg-green-600 text-xs px-2 py-1 rounded font-mono">GET</span>
              <code className="text-sm text-gray-300">/health</code>
              <span className="text-xs text-gray-500 ml-auto">Health check</span>
            </div>
            <div className="bg-gray-900 p-3 rounded-lg border border-gray-700 flex items-center gap-3">
              <span className="bg-blue-600 text-xs px-2 py-1 rounded font-mono">WS</span>
              <code className="text-sm text-gray-300">/realtime</code>
              <span className="text-xs text-gray-500 ml-auto">Real-time transcription</span>
            </div>
            <div className="bg-gray-900 p-3 rounded-lg border border-gray-700 flex items-center gap-3">
              <span className="bg-green-600 text-xs px-2 py-1 rounded font-mono">POST</span>
              <code className="text-sm text-gray-300">/transcribe</code>
              <span className="text-xs text-gray-500 ml-auto">File transcription</span>
            </div>
            <div className="bg-gray-900 p-3 rounded-lg border border-gray-700 flex items-center gap-3">
              <span className="bg-green-600 text-xs px-2 py-1 rounded font-mono">POST</span>
              <code className="text-sm text-gray-300">/cloud-asr</code>
              <span className="text-xs text-gray-500 ml-auto">Cloud ASR evaluation</span>
            </div>
          </div>
        </section>

        {/* Security & Best Practices */}
        <section className="bg-gray-800/50 backdrop-blur-md p-8 rounded-xl border border-gray-700 shadow-2xl">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-white">
            <ShieldAlert className="w-6 h-6 text-red-400" /> Security & Best Practices
          </h2>
          <ul className="space-y-3">
            <li className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-gray-300"><strong>Audio Privacy:</strong> Ensure audio data handling complies with privacy regulations. Consider on-premises deployment for sensitive data.</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-gray-300"><strong>API Key Security:</strong> Rotate API keys regularly and use different keys for different environments.</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-gray-300"><strong>Cost Monitoring:</strong> Track usage across providers to optimize costs. Groq offers best value for high-volume usage.</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-gray-300"><strong>Latency Optimization:</strong> Use WebSocket connections for real-time applications to minimize latency.</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <span className="text-sm text-gray-300"><strong>Fallback Configuration:</strong> Configure automatic fallback to ensure service continuity during provider outages.</span>
            </li>
          </ul>
        </section>

      </div>
    </div>
  );
}