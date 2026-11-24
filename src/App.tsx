/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Square, Timer, BarChart3, Settings, Download, ArrowLeft, Video, CheckCircle2, AlertCircle } from 'lucide-react';

interface StudySession {
  id: string;
  name: string;
  date: string; // YYYY-MM-DD
  durationSeconds: number;
  pauses: number;
}

const STORAGE_KEY = 'flow_study_tracker_sessions_v2';
const TIMEOUT_KEY = 'flow_study_tracker_timeout';

const DEFAULT_SESSIONS: StudySession[] = [
  {
    id: 'seed-1',
    name: 'Cardiovascular Pathology',
    date: new Date().toISOString().split('T')[0],
    durationSeconds: 3300,
    pauses: 1,
  },
  {
    id: 'seed-2',
    name: 'Renal Physiology Review',
    date: new Date(Date.now() - 86400000).toISOString().split('T')[0],
    durationSeconds: 5400,
    pauses: 2,
  },
  {
    id: 'seed-3',
    name: 'Autonomic Pharmacology',
    date: new Date(Date.now() - 86400000).toISOString().split('T')[0],
    durationSeconds: 2700,
    pauses: 0,
  },
];

export default function App() {
  // Navigation: 'home' | 'active' | 'paused' | 'end' | 'stats' | 'settings'
  const [currentScreen, setCurrentScreen] = useState<'home' | 'active' | 'paused' | 'end' | 'stats' | 'settings'>('home');
  
  // Session State
  const [sessionName, setSessionName] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pauseCount, setPauseCount] = useState(0);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [lastCompletedSession, setLastCompletedSession] = useState<StudySession | null>(null);
  
  // Settings State
  const [awayTimeout, setAwayTimeout] = useState<number>(10); // 5, 10, or 30 seconds

  // Camera & AI Presence State
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const inactivityTimerRef = useRef<number>(0);
  const motionCheckIntervalRef = useRef<number | null>(null);

  // Toast notification
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Load initial sessions & settings
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setSessions(JSON.parse(saved));
      } else {
        setSessions(DEFAULT_SESSIONS);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SESSIONS));
      }
      const savedTimeout = localStorage.getItem(TIMEOUT_KEY);
      if (savedTimeout) {
        setAwayTimeout(Number(savedTimeout));
      }
    } catch (e) {
      console.error('Failed to load storage:', e);
      setSessions(DEFAULT_SESSIONS);
    }
  }, []);

  const saveSessionsToStorage = (newSessions: StudySession[]) => {
    setSessions(newSessions);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSessions));
    } catch (e) {
      console.error('Failed to save sessions:', e);
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 2500);
  };

  // Timer Tick
  useEffect(() => {
    let interval: number | null = null;
    if (currentScreen === 'active') {
      interval = window.setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [currentScreen]);

  // Camera & AI Motion Detection setup when entering active screen
  useEffect(() => {
    if (currentScreen === 'active' || currentScreen === 'paused') {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [currentScreen]);

  const startCamera = async () => {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 160, height: 120, facingMode: 'user' },
          audio: false,
        });
        mediaStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraActive(true);
        setCameraError(false);
        startMotionDetection();
      } else {
        setCameraError(true);
      }
    } catch (err) {
      console.warn('Webcam permission denied or unavailable:', err);
      setCameraError(true);
      setCameraActive(false);
    }
  };

  const stopCamera = () => {
    if (motionCheckIntervalRef.current) {
      clearInterval(motionCheckIntervalRef.current);
      motionCheckIntervalRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setCameraActive(false);
  };

  const startMotionDetection = () => {
    inactivityTimerRef.current = 0;
    prevFrameRef.current = null;

    motionCheckIntervalRef.current = window.setInterval(() => {
      if (!videoRef.current || videoRef.current.readyState < 2 || currentScreen !== 'active') {
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      ctx.drawImage(videoRef.current, 0, 0, 64, 48);
      const frameData = ctx.getImageData(0, 0, 64, 48).data;

      if (prevFrameRef.current) {
        let diff = 0;
        for (let i = 0; i < frameData.length; i += 16) {
          diff += Math.abs(frameData[i] - prevFrameRef.current[i]);
        }

        // If difference is low (user left desk / motionless), increment inactivity
        if (diff < 1500) {
          inactivityTimerRef.current += 1;
          if (inactivityTimerRef.current >= awayTimeout && currentScreen === 'active') {
            // Trigger Auto-Pause
            handleAutoPause();
          }
        } else {
          // Motion detected! Reset inactivity
          inactivityTimerRef.current = 0;
        }
      }
      prevFrameRef.current = new Uint8ClampedArray(frameData);
    }, 1000);
  };

  const handleAutoPause = () => {
    setPauseCount((prev) => prev + 1);
    setCurrentScreen('paused');
    showToast('AI Sensor: Away detected. Paused.');
  };

  const handleStartSession = () => {
    const title = sessionName.trim() || 'Focused Study Block';
    setSessionName(title);
    setElapsedSeconds(0);
    setPauseCount(0);
    setCurrentScreen('active');
  };

  const handlePauseToggle = () => {
    if (currentScreen === 'active') {
      setPauseCount((prev) => prev + 1);
      setCurrentScreen('paused');
    } else if (currentScreen === 'paused') {
      setCurrentScreen('active');
    }
  };

  const handleStopSession = () => {
    const newSession: StudySession = {
      id: 'sess-' + Date.now(),
      name: sessionName || 'Study Session',
      date: new Date().toISOString().split('T')[0],
      durationSeconds: elapsedSeconds,
      pauses: pauseCount,
    };

    setLastCompletedSession(newSession);
    const updated = [newSession, ...sessions];
    saveSessionsToStorage(updated);
    setCurrentScreen('end');
  };

  const handleExportCSV = (sessionToExport?: StudySession) => {
    const list = sessionToExport ? [sessionToExport] : sessions;
    if (list.length === 0) {
      showToast('No sessions to export');
      return;
    }

    const headers = ['Session Name', 'Date', 'Duration (HH:MM:SS)', 'Duration (Seconds)', 'Pause Count'];
    const rows = list.map((s) => [
      `"${s.name.replace(/"/g, '""')}"`,
      s.date,
      formatHHMMSS(s.durationSeconds),
      s.durationSeconds,
      s.pauses,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `flow-study-log-${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('CSV Exported Successfully');
  };

  const formatHHMMSS = (totalSeconds: number) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
  };

  const formatHoursMinutes = (totalSeconds: number) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    return `${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m`;
  };

  const formatShortDate = (isoStr: string) => {
    const parts = isoStr.split('-');
    if (parts.length !== 3) return isoStr;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mIdx = parseInt(parts[1], 10) - 1;
    return `${months[mIdx] || parts[1]} ${parseInt(parts[2], 10)}`;
  };

  // Compute stats
  const todayISO = new Date().toISOString().split('T')[0];
  const todaySeconds = sessions
    .filter((s) => s.date === todayISO)
    .reduce((acc, s) => acc + s.durationSeconds, 0);
  const allTimeSeconds = sessions.reduce((acc, s) => acc + s.durationSeconds, 0);

  return (
    <div className="min-h-screen bg-[#0D0D0D] text-[#F5F5F5] flex justify-center selection:bg-[#FF4F00] selection:text-white font-sans antialiased">
      {/* Mobile container shell */}
      <div className="w-full max-w-md bg-[#0D0D0D] border-x border-[#262626] flex flex-col min-h-screen relative">
        
        {/* Toast Notification Banner */}
        {toastMessage && (
          <div className="fixed top-16 left-1/2 -translate-x-1/2 bg-[#141414] border border-[#FF4F00] text-[#F5F5F5] text-xs px-4 py-2 z-50 tracking-wide font-mono rounded-[4px]">
            {toastMessage}
          </div>
        )}

        {/* =========================================================
             SCREEN 1: HOME SCREEN
        ========================================================== */}
        {currentScreen === 'home' && (
          <div className="flex-1 flex flex-col justify-between p-6">
            <header className="flex items-center justify-between h-12 border-b border-[#262626] pb-3 mb-6">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 bg-[#FF4F00]"></div>
                <span className="font-bold text-lg tracking-tight text-[#F5F5F5] font-mono">Flow</span>
              </div>
              <button
                onClick={() => setCurrentScreen('settings')}
                className="text-[#8A8A8A] hover:text-[#F5F5F5] p-1 transition-colors"
                aria-label="Settings"
              >
                <Settings className="w-5 h-5" />
              </button>
            </header>

            <div className="space-y-6 my-auto">
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-[#8A8A8A] mb-2">New Session</p>
                <h1 className="text-2xl font-bold tracking-tight text-[#F5F5F5] mb-6">
                  Define your objective.
                </h1>

                <label htmlFor="session-input" className="block text-xs font-medium text-[#8A8A8A] uppercase tracking-wider mb-2">
                  Name your session
                </label>
                <input
                  id="session-input"
                  type="text"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleStartSession()}
                  placeholder="e.g. Anatomy — Ch. 4"
                  maxLength={50}
                  className="w-full bg-[#141414] border border-[#262626] focus:border-[#FF4F00] focus:outline-none text-[#F5F5F5] px-4 py-3.5 text-sm rounded-[4px] transition-colors"
                  autoFocus
                />
              </div>

              {/* Quick presets */}
              <div>
                <span className="block text-[11px] font-mono uppercase tracking-wider text-[#525252] mb-2">Presets</span>
                <div className="flex flex-wrap gap-2">
                  {[
                    'Bangla',
                    'English',
                    'Teacher',
                    'Higher Math',
                    'Physics',
                    'Chemistry',
                    'Biology',
                    'ICT',
                    'Self Study',
                    'Online class',
                    'Work (BAAYAN)',
                    'Work (NIVANTO)'
                  ].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => setSessionName(preset)}
                      className="text-xs bg-[#141414] hover:bg-[#1C1C1C] border border-[#262626] hover:border-[#8A8A8A] text-[#8A8A8A] hover:text-[#F5F5F5] px-3 py-1.5 rounded-[4px] transition-colors"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-8 pb-4">
              <button
                onClick={handleStartSession}
                className="w-full bg-[#FF4F00] hover:bg-[#E04600] active:scale-[0.99] text-white font-bold text-sm tracking-widest uppercase py-4 rounded-[4px] flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>START</span>
              </button>
            </div>
          </div>
        )}

        {/* =========================================================
             SCREEN 2: ACTIVE TIMER SCREEN
        ========================================================== */}
        {currentScreen === 'active' && (
          <div className="flex-1 flex flex-col justify-between p-6 relative">
            <header className="flex items-center justify-between h-12 border-b border-[#262626] pb-3">
              <div className="text-xs text-[#8A8A8A] font-mono truncate max-w-[260px]">
                {sessionName || 'Untitled Session'}
              </div>
              <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#141414] border border-[#FF4F00] text-[11px] font-mono text-[#F5F5F5] rounded-[4px]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#FF4F00] animate-pulse"></span>
                Studying ✅
              </div>
            </header>

            <div className="flex flex-col items-center justify-center my-auto">
              <div className="font-mono text-6xl sm:text-7xl font-bold tracking-tighter text-[#F5F5F5] tabular-nums mb-4">
                {formatHHMMSS(elapsedSeconds)}
              </div>
              <p className="text-xs text-[#8A8A8A] font-mono tracking-wider">
                AI Presence Monitoring Active
              </p>
            </div>

            <div className="space-y-3 pb-8">
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={handlePauseToggle}
                  className="bg-[#141414] hover:bg-[#1C1C1C] border border-[#262626] text-[#F5F5F5] font-medium text-xs tracking-wider uppercase py-3.5 rounded-[4px] flex items-center justify-center gap-2 transition-colors"
                >
                  <Pause className="w-3.5 h-3.5" />
                  <span>Pause</span>
                </button>
                <button
                  onClick={handleStopSession}
                  className="bg-[#141414] hover:bg-[#1C1C1C] border border-[#3A2222] hover:border-[#FF4F00] text-[#F5F5F5] font-medium text-xs tracking-wider uppercase py-3.5 rounded-[4px] flex items-center justify-center gap-2 transition-colors"
                >
                  <Square className="w-3.5 h-3.5 text-[#FF4F00]" />
                  <span>Stop</span>
                </button>
              </div>

              <div className="text-center pt-2">
                <button
                  onClick={handleAutoPause}
                  className="text-[11px] text-[#525252] hover:text-[#8A8A8A] underline underline-offset-4 transition-colors"
                >
                  Simulate AI Desk Departure ({awayTimeout}s timeout)
                </button>
              </div>
            </div>

            {/* Live Camera Feed Preview (Bottom-Right Corner) */}
            <div className="absolute bottom-6 right-6 w-28 h-20 bg-[#141414] border border-[#FF4F00] rounded-[4px] overflow-hidden flex flex-col justify-between shadow-sm z-20">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
              {cameraError && (
                <div className="w-full h-full flex flex-col items-center justify-center p-1 text-center bg-[#141414]">
                  <Video className="w-4 h-4 text-[#8A8A8A] mb-1" />
                  <span className="text-[8px] font-mono text-[#8A8A8A]">AI SENSOR</span>
                </div>
              )}
              <div className="absolute top-1 left-1 bg-[#0D0D0D]/80 px-1 py-0.5 rounded-[2px] text-[8px] font-mono text-[#FF4F00] flex items-center gap-1 border border-[#262626]">
                <span className="w-1 h-1 bg-[#FF4F00] rounded-full"></span>
                CAM
              </div>
            </div>
            <canvas ref={canvasRef} width="64" height="48" className="hidden" />
          </div>
        )}

        {/* =========================================================
             SCREEN 3: AUTO-PAUSED SCREEN
        ========================================================== */}
        {currentScreen === 'paused' && (
          <div className="flex-1 flex flex-col justify-between p-6 relative">
            <header className="flex items-center justify-between h-12 border-b border-[#262626] pb-3">
              <div className="text-xs text-[#8A8A8A] font-mono truncate max-w-[260px]">
                {sessionName || 'Untitled Session'}
              </div>
              <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#141414] border border-[#262626] text-[11px] font-mono text-[#8A8A8A] rounded-[4px]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#8A8A8A]"></span>
                Away ⏸️
              </div>
            </header>

            <div className="flex flex-col items-center justify-center my-auto">
              <div className="font-mono text-6xl sm:text-7xl font-bold tracking-tighter text-[#525252] tabular-nums opacity-50 mb-3">
                {formatHHMMSS(elapsedSeconds)}
              </div>
              <p className="text-xs font-mono text-[#8A8A8A] tracking-wider animate-pulse">
                Resume when you return
              </p>
            </div>

            <div className="space-y-3 pb-8">
              <button
                onClick={handlePauseToggle}
                className="w-full bg-[#FF4F00] hover:bg-[#E04600] active:scale-[0.99] text-white font-bold text-sm tracking-widest uppercase py-4 rounded-[4px] flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>RESUME SESSION</span>
              </button>
              <button
                onClick={handleStopSession}
                className="w-full bg-[#141414] hover:bg-[#1C1C1C] border border-[#3A2222] text-[#F5F5F5] font-medium text-xs tracking-wider uppercase py-3.5 rounded-[4px] flex items-center justify-center gap-2 transition-colors"
              >
                <Square className="w-3.5 h-3.5 text-[#FF4F00]" />
                <span>Stop Session</span>
              </button>
            </div>

            {/* Live Camera Feed Preview (Dimmed in paused state) */}
            <div className="absolute bottom-6 right-6 w-28 h-20 bg-[#141414] border border-[#262626] rounded-[4px] overflow-hidden flex flex-col justify-between opacity-60 z-20">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
              <div className="absolute top-1 left-1 bg-[#0D0D0D]/80 px-1 py-0.5 rounded-[2px] text-[8px] font-mono text-[#8A8A8A] border border-[#262626]">
                PAUSED
              </div>
            </div>
            <canvas ref={canvasRef} width="64" height="48" className="hidden" />
          </div>
        )}

        {/* =========================================================
             SCREEN 4: SESSION END SCREEN
        ========================================================== */}
        {currentScreen === 'end' && (
          <div className="flex-1 flex flex-col justify-between p-6">
            <header className="flex items-center justify-between h-12 border-b border-[#262626] pb-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 bg-[#FF4F00]"></div>
                <span className="font-bold text-lg tracking-tight text-[#F5F5F5] font-mono">Flow</span>
              </div>
            </header>

            <div className="space-y-6 my-auto">
              <div>
                <p className="text-[11px] font-mono uppercase tracking-widest text-[#8A8A8A] mb-1">Session Complete</p>
                <h1 className="text-2xl font-bold tracking-tight text-[#F5F5F5] mb-6">
                  Good work.
                </h1>

                {/* Summary Card */}
                <div className="bg-[#141414] border border-[#262626] p-5 rounded-[4px] space-y-4">
                  <div className="border-b border-[#262626] pb-3">
                    <span className="block text-[10px] font-mono uppercase tracking-wider text-[#8A8A8A] mb-1">Session Title</span>
                    <p className="text-base font-semibold text-[#F5F5F5] truncate">
                      {lastCompletedSession?.name || sessionName}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4 border-b border-[#262626] pb-3">
                    <div>
                      <span className="block text-[10px] font-mono uppercase tracking-wider text-[#8A8A8A] mb-1">Date</span>
                      <p className="text-xs font-mono text-[#F5F5F5]">
                        {lastCompletedSession?.date ? formatShortDate(lastCompletedSession.date) : 'Today'}
                      </p>
                    </div>
                    <div>
                      <span className="block text-[10px] font-mono uppercase tracking-wider text-[#8A8A8A] mb-1">Pause Count</span>
                      <p className="text-xs font-mono text-[#F5F5F5]">
                        {lastCompletedSession?.pauses ?? pauseCount}
                      </p>
                    </div>
                  </div>

                  <div>
                    <span className="block text-[10px] font-mono uppercase tracking-wider text-[#8A8A8A] mb-1">Total Duration</span>
                    <p className="font-mono text-3xl font-bold text-[#FF4F00]">
                      {formatHHMMSS(lastCompletedSession?.durationSeconds ?? elapsedSeconds)}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-6 pb-2">
              <button
                onClick={() => handleExportCSV(lastCompletedSession || undefined)}
                className="w-full bg-[#141414] hover:bg-[#1C1C1C] border border-[#262626] text-[#F5F5F5] font-medium text-xs tracking-wider uppercase py-3.5 rounded-[4px] flex items-center justify-center gap-2 transition-colors"
              >
                <Download className="w-4 h-4 text-[#FF4F00]" />
                <span>Export CSV</span>
              </button>
              <button
                onClick={() => {
                  setSessionName('');
                  setElapsedSeconds(0);
                  setPauseCount(0);
                  setCurrentScreen('home');
                }}
                className="w-full bg-[#FF4F00] hover:bg-[#E04600] active:scale-[0.99] text-white font-bold text-sm tracking-widest uppercase py-4 rounded-[4px] flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <span>Back to Home</span>
              </button>
            </div>
          </div>
        )}

        {/* =========================================================
             SCREEN 5: STATS SCREEN
        ========================================================== */}
        {currentScreen === 'stats' && (
          <div className="flex-1 flex flex-col p-6 pb-20">
            <header className="flex items-center justify-between h-12 border-b border-[#262626] pb-3 mb-6">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 bg-[#FF4F00]"></div>
                <span className="font-bold text-lg tracking-tight text-[#F5F5F5] font-mono">Stats</span>
              </div>
              <button
                onClick={() => handleExportCSV()}
                className="text-xs text-[#8A8A8A] hover:text-[#F5F5F5] flex items-center gap-1 font-mono transition-colors"
              >
                <Download className="w-3.5 h-3.5 text-[#FF4F00]" />
                <span>Export All</span>
              </button>
            </header>

            {/* Totals Hero Card */}
            <div className="bg-[#141414] border border-[#262626] p-5 rounded-[4px] mb-6">
              <span className="block text-[11px] font-mono uppercase tracking-widest text-[#8A8A8A] mb-1">Today's Total Time</span>
              <div className="font-mono text-4xl sm:text-5xl font-bold tracking-tight text-[#F5F5F5] mb-4">
                {formatHoursMinutes(todaySeconds)}
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-[#262626] text-xs">
                <span className="font-mono text-[#8A8A8A] uppercase tracking-wider">All-Time Invested</span>
                <span className="font-mono font-semibold text-[#FF4F00]">{formatHoursMinutes(allTimeSeconds)}</span>
              </div>
            </div>

            {/* Session History List / Table */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-mono uppercase tracking-widest text-[#8A8A8A]">Session History</h2>
              <span className="text-[11px] font-mono text-[#525252]">{sessions.length} recorded</span>
            </div>

            <div className="flex-1 border border-[#262626] bg-[#141414] rounded-[4px] overflow-hidden flex flex-col">
              <div className="grid grid-cols-12 gap-2 px-3.5 py-2.5 border-b border-[#262626] bg-[#0D0D0D] text-[10px] font-mono uppercase tracking-wider text-[#8A8A8A]">
                <div className="col-span-5">Name</div>
                <div className="col-span-3">Date</div>
                <div className="col-span-3 text-right">Duration</div>
                <div className="col-span-1 text-right">P</div>
              </div>

              <div className="divide-y divide-[#262626] overflow-y-auto max-h-[320px]">
                {sessions.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[#525252]">
                    No study sessions recorded yet.
                  </div>
                ) : (
                  sessions.map((s) => (
                    <div key={s.id} className="grid grid-cols-12 gap-2 px-3.5 py-3 items-center text-xs hover:bg-[#1C1C1C] transition-colors">
                      <div className="col-span-5 font-medium text-[#F5F5F5] truncate" title={s.name}>
                        {s.name}
                      </div>
                      <div className="col-span-3 text-[#8A8A8A] font-mono text-[11px]">
                        {formatShortDate(s.date)}
                      </div>
                      <div className="col-span-3 text-right font-mono text-[#F5F5F5] text-[11px]">
                        {formatHoursMinutes(s.durationSeconds)}
                      </div>
                      <div className="col-span-1 text-right font-mono text-[#8A8A8A] text-[11px]">
                        {s.pauses}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* =========================================================
             SCREEN 6: SETTINGS SCREEN
        ========================================================== */}
        {currentScreen === 'settings' && (
          <div className="flex-1 flex flex-col p-6 pb-20">
            <header className="flex items-center justify-between h-12 border-b border-[#262626] pb-3 mb-6">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setCurrentScreen('home')}
                  className="text-[#8A8A8A] hover:text-[#F5F5F5] p-1 transition-colors"
                  aria-label="Back"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <span className="font-bold text-lg tracking-tight text-[#F5F5F5] font-mono">Settings</span>
              </div>
            </header>

            <div className="space-y-6">
              <div className="bg-[#141414] border border-[#262626] p-5 rounded-[4px]">
                <h3 className="text-xs font-mono uppercase tracking-widest text-[#8A8A8A] mb-2">AI Presence Sensor</h3>
                <label className="block text-sm font-medium text-[#F5F5F5] mb-1">
                  Away Timeout
                </label>
                <p className="text-xs text-[#8A8A8A] mb-4">
                  Duration of inactivity before automatically pausing your active study block.
                </p>

                {/* Segmented Control / 3 Flat Toggle Buttons (5s / 10s / 30s) */}
                <div className="grid grid-cols-3 gap-2">
                  {[5, 10, 30].map((sec) => (
                    <button
                      key={sec}
                      onClick={() => {
                        setAwayTimeout(sec);
                        localStorage.setItem(TIMEOUT_KEY, String(sec));
                        showToast(`Away timeout set to ${sec}s`);
                      }}
                      className={`py-3 text-xs font-mono uppercase tracking-wider rounded-[4px] border transition-colors ${
                        awayTimeout === sec
                          ? 'bg-[#FF4F00] border-[#FF4F00] text-white font-bold'
                          : 'bg-[#0D0D0D] border-[#262626] text-[#8A8A8A] hover:text-[#F5F5F5]'
                      }`}
                    >
                      {sec} Seconds
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#141414] border border-[#262626] p-5 rounded-[4px]">
                <h3 className="text-xs font-mono uppercase tracking-widest text-[#8A8A8A] mb-2">Data &amp; Storage</h3>
                <p className="text-xs text-[#8A8A8A] mb-4">
                  All session history is stored locally on your device in localStorage.
                </p>
                <button
                  onClick={() => {
                    if (window.confirm('Clear all study session history?')) {
                      setSessions([]);
                      localStorage.removeItem(STORAGE_KEY);
                      showToast('History cleared');
                    }
                  }}
                  className="text-xs text-[#FF4F00] hover:underline font-mono"
                >
                  Clear All History Data
                </button>
              </div>
            </div>
          </div>
        )}

        {/* =========================================================
             BOTTOM NAVIGATION BAR (3 items: Timer, Stats, Settings)
        ========================================================== */}
        {currentScreen !== 'active' && currentScreen !== 'paused' && (
          <nav className="h-16 bg-[#0D0D0D] border-t border-[#262626] grid grid-cols-3 shrink-0 z-30">
            <button
              onClick={() => setCurrentScreen('home')}
              className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                currentScreen === 'home' ? 'text-[#FF4F00]' : 'text-[#8A8A8A] hover:text-[#F5F5F5]'
              }`}
            >
              <Timer className="w-5 h-5 stroke-[1.75]" />
              <span className="text-[10px] font-mono uppercase tracking-wider">Timer</span>
            </button>

            <button
              onClick={() => setCurrentScreen('stats')}
              className={`flex flex-col items-center justify-center gap-1 border-x border-[#262626] transition-colors ${
                currentScreen === 'stats' ? 'text-[#FF4F00]' : 'text-[#8A8A8A] hover:text-[#F5F5F5]'
              }`}
            >
              <BarChart3 className="w-5 h-5 stroke-[1.75]" />
              <span className="text-[10px] font-mono uppercase tracking-wider">Stats</span>
            </button>

            <button
              onClick={() => setCurrentScreen('settings')}
              className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                currentScreen === 'settings' ? 'text-[#FF4F00]' : 'text-[#8A8A8A] hover:text-[#F5F5F5]'
              }`}
            >
              <Settings className="w-5 h-5 stroke-[1.75]" />
              <span className="text-[10px] font-mono uppercase tracking-wider">Settings</span>
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}
