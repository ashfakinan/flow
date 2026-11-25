/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Square, Timer, BarChart3, Settings, Download, ArrowLeft, Video, SwitchCamera, LogIn, LogOut, CheckCircle2 } from 'lucide-react';
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, getDocs, query, orderBy, onSnapshot } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);

interface StudySession {
  id: string;
  userId: string;
  name: string;
  date: string; // YYYY-MM-DD
  durationSeconds: number;
  breakDurationSeconds: number;
  pauses: number;
}

const STORAGE_KEY = 'flow_study_tracker_sessions_v3';
const TIMEOUT_KEY = 'flow_study_tracker_timeout';

const DEFAULT_SESSIONS: StudySession[] = [
  {
    id: 'seed-1',
    userId: 'local',
    name: 'Cardiovascular Pathology',
    date: new Date().toISOString().split('T')[0],
    durationSeconds: 3300,
    breakDurationSeconds: 180,
    pauses: 1,
  },
  {
    id: 'seed-2',
    userId: 'local',
    name: 'Renal Physiology Review',
    date: new Date(Date.now() - 86400000).toISOString().split('T')[0],
    durationSeconds: 5400,
    breakDurationSeconds: 300,
    pauses: 2,
  },
];

export default function App() {
  // Auth State
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Navigation: 'home' | 'active' | 'paused' | 'end' | 'stats' | 'settings'
  const [currentScreen, setCurrentScreen] = useState<'home' | 'active' | 'paused' | 'end' | 'stats' | 'settings'>('home');
  
  // Session State
  const [sessionName, setSessionName] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [breakDurationSeconds, setBreakDurationSeconds] = useState(0);
  const [pauseCount, setPauseCount] = useState(0);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [lastCompletedSession, setLastCompletedSession] = useState<StudySession | null>(null);
  
  // Settings State
  const [awayTimeout, setAwayTimeout] = useState<number>(10); // 5, 10, or 30 seconds
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  // Camera & AI Presence State
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [faceDetected, setFaceDetected] = useState(true);
  const [awayCountdown, setAwayCountdown] = useState<number | null>(null);
  const [returnCountdown, setReturnCountdown] = useState<number | null>(null);
  const [pauseReason, setPauseReason] = useState<'auto' | 'manual'>('auto');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const faceDetectorRef = useRef<FaceDetector | null>(null);
  const detectionIntervalRef = useRef<number | null>(null);
  const lastSeenAtRef = useRef<number>(Date.now());
  const lastVideoTimeRef = useRef<number>(0);
  const returnSecondsCountRef = useRef<number>(0);

  const currentScreenRef = useRef(currentScreen);
  currentScreenRef.current = currentScreen;

  const awayTimeoutRef = useRef(awayTimeout);
  awayTimeoutRef.current = awayTimeout;

  const pauseReasonRef = useRef(pauseReason);
  pauseReasonRef.current = pauseReason;

  // Toast notification
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Fetch sessions from Firestore when user logs in, or fallback to localStorage
  useEffect(() => {
    if (user) {
      const q = query(collection(db, 'users', user.uid, 'sessions'));
      const unsub = onSnapshot(q, (snapshot) => {
        const cloudSessions: StudySession[] = [];
        snapshot.forEach((docSnap) => {
          cloudSessions.push(docSnap.data() as StudySession);
        });
        cloudSessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setSessions(cloudSessions);
      }, (err) => {
        console.warn('Firestore sync error:', err);
        loadLocalSessions();
      });
      return () => unsub();
    } else {
      loadLocalSessions();
    }
  }, [user]);

  const loadLocalSessions = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setSessions(JSON.parse(saved));
      } else {
        setSessions(DEFAULT_SESSIONS);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SESSIONS));
      }
    } catch (e) {
      console.error('Failed to load local storage:', e);
      setSessions(DEFAULT_SESSIONS);
    }
  };

  // Load timeout setting
  useEffect(() => {
    const savedTimeout = localStorage.getItem(TIMEOUT_KEY);
    if (savedTimeout) {
      setAwayTimeout(Number(savedTimeout));
    }
  }, []);

  const saveSessionToCloudOrLocal = async (newSession: StudySession) => {
    const updated = [newSession, ...sessions];
    setSessions(updated);

    if (user) {
      try {
        await setDoc(doc(db, 'users', user.uid, 'sessions', newSession.id), newSession);
        showToast('Session synced to Firebase');
      } catch (err) {
        console.error('Failed to save session to Firestore:', err);
        showToast('Saved locally (Cloud sync failed)');
      }
    } else {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save local session:', e);
      }
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 2800);
  };

  // Timer Tick (Active Session)
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

  // Break Duration Tick (Paused Session)
  useEffect(() => {
    let interval: number | null = null;
    if (currentScreen === 'paused') {
      interval = window.setInterval(() => {
        setBreakDurationSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [currentScreen]);

  // Reset grace timers whenever returning to active screen
  useEffect(() => {
    if (currentScreen === 'active') {
      lastSeenAtRef.current = Date.now();
      returnSecondsCountRef.current = 0;
      setAwayCountdown(null);
      setReturnCountdown(null);
    }
  }, [currentScreen]);

  // Camera & AI Face Detection lifecycle
  const isSessionRunning = currentScreen === 'active' || currentScreen === 'paused';

  useEffect(() => {
    if (isSessionRunning) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isSessionRunning, facingMode]);

  const initFaceDetector = async (): Promise<FaceDetector | null> => {
    if (faceDetectorRef.current) return faceDetectorRef.current;

    const createWithSource = async (wasmBase: string, modelPath: string) => {
      const vision = await FilesetResolver.forVisionTasks(wasmBase);
      try {
        return await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelPath,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.45,
        });
      } catch {
        return await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelPath,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.45,
        });
      }
    };

    try {
      const detector = await createWithSource(
        '/mediapipe/wasm',
        '/mediapipe/models/blaze_face_short_range.tflite'
      );
      faceDetectorRef.current = detector;
      setAiReady(true);
      return detector;
    } catch (localErr) {
      console.warn('Local MediaPipe load failed, falling back to CDN:', localErr);
      try {
        const detector = await createWithSource(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm',
          'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
        );
        faceDetectorRef.current = detector;
        setAiReady(true);
        return detector;
      } catch (cdnErr) {
        console.error('Failed to initialize FaceDetector:', cdnErr);
        setAiReady(false);
        return null;
      }
    }
  };

  const toggleFacingMode = () => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(next);
    stopCamera();
    setTimeout(() => {
      startCamera();
    }, 150);
    showToast(`Switched to ${next === 'user' ? 'Front' : 'Back'} Camera`);
  };

  const startCamera = async () => {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: facingMode },
          audio: false,
        });
        mediaStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setCameraActive(true);
        setCameraError(false);

        await initFaceDetector();
        lastSeenAtRef.current = Date.now();
        startFacePresenceLoop();
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
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setCameraActive(false);
    setAwayCountdown(null);
    setReturnCountdown(null);
  };

  const startFacePresenceLoop = () => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
    }
    lastSeenAtRef.current = Date.now();
    returnSecondsCountRef.current = 0;

    detectionIntervalRef.current = window.setInterval(() => {
      const video = videoRef.current;
      const detector = faceDetectorRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        return;
      }
      if (!detector) {
        lastSeenAtRef.current = Date.now();
        return;
      }

      const screen = currentScreenRef.current;
      if (screen !== 'active' && screen !== 'paused') {
        return;
      }

      try {
        const nowMs = performance.now();
        const timestamp = nowMs > lastVideoTimeRef.current ? nowMs : lastVideoTimeRef.current + 1;
        lastVideoTimeRef.current = timestamp;

        const result = detector.detectForVideo(video, timestamp);
        const isPersonPresent = Boolean(result.detections && result.detections.length > 0);
        setFaceDetected(isPersonPresent);

        if (screen === 'active') {
          if (isPersonPresent) {
            lastSeenAtRef.current = Date.now();
            setAwayCountdown(null);
          } else {
            const elapsedAwayMs = Date.now() - lastSeenAtRef.current;
            const timeoutMs = awayTimeoutRef.current * 1000;
            const remainingSec = Math.max(0, Math.ceil((timeoutMs - elapsedAwayMs) / 1000));
            setAwayCountdown(elapsedAwayMs >= 1000 ? remainingSec : null);

            if (elapsedAwayMs >= timeoutMs) {
              handleAutoPause();
            }
          }
        } else if (screen === 'paused') {
          if (pauseReasonRef.current === 'auto') {
            if (isPersonPresent) {
              returnSecondsCountRef.current += 1;
              const remainingReturnSec = Math.max(0, 5 - returnSecondsCountRef.current);
              setReturnCountdown(remainingReturnSec);

              // Must stay in camera for 5 consecutive seconds to resume
              if (returnSecondsCountRef.current >= 5) {
                returnSecondsCountRef.current = 0;
                setReturnCountdown(null);
                lastSeenAtRef.current = Date.now();
                setAwayCountdown(null);
                setCurrentScreen('active');
                showToast('AI Sensor: 5s presence confirmed. Resumed.');
              }
            } else {
              returnSecondsCountRef.current = 0;
              setReturnCountdown(null);
            }
          }
        }
      } catch (err) {
        console.warn('Face detection frame skipped:', err);
      }
    }, 1000); // 1-second interval tick for robust 5-second countdown
  };

  const handleAutoPause = () => {
    setPauseReason('auto');
    setAwayCountdown(null);
    returnSecondsCountRef.current = 0;
    setReturnCountdown(null);
    setPauseCount((prev) => prev + 1);
    setCurrentScreen('paused');
    showToast('AI Sensor: Away detected. Paused.');
  };

  const handleStartSession = () => {
    const title = sessionName.trim() || 'Focused Study Block';
    setSessionName(title);
    setElapsedSeconds(0);
    setBreakDurationSeconds(0);
    setPauseCount(0);
    setPauseReason('auto');
    setAwayCountdown(null);
    setReturnCountdown(null);
    setFaceDetected(true);
    lastSeenAtRef.current = Date.now();
    setCurrentScreen('active');
  };

  const handlePauseToggle = () => {
    if (currentScreen === 'active') {
      setPauseReason('manual');
      setAwayCountdown(null);
      setReturnCountdown(null);
      setPauseCount((prev) => prev + 1);
      setCurrentScreen('paused');
    } else if (currentScreen === 'paused') {
      lastSeenAtRef.current = Date.now();
      returnSecondsCountRef.current = 0;
      setAwayCountdown(null);
      setReturnCountdown(null);
      setCurrentScreen('active');
    }
  };

  const handleStopSession = () => {
    const newSession: StudySession = {
      id: 'sess-' + Date.now(),
      userId: user ? user.uid : 'local',
      name: sessionName || 'Study Session',
      date: new Date().toISOString().split('T')[0],
      durationSeconds: elapsedSeconds,
      breakDurationSeconds: breakDurationSeconds,
      pauses: pauseCount,
    };

    setLastCompletedSession(newSession);
    saveSessionToCloudOrLocal(newSession);
    setCurrentScreen('end');
  };

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      showToast('Signed in successfully');
    } catch (err) {
      console.error('Google Sign-In failed:', err);
      showToast('Sign-in failed. Please try again.');
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      showToast('Signed out');
    } catch (err) {
      console.error('Sign out failed:', err);
    }
  };

  const handleExportCSV = (sessionToExport?: StudySession) => {
    const list = sessionToExport ? [sessionToExport] : sessions;
    if (list.length === 0) {
      showToast('No sessions to export');
      return;
    }

    const headers = ['Session Name', 'Date', 'Duration (HH:MM:SS)', 'Break (HH:MM:SS)', 'Pause Count'];
    const rows = list.map((s) => [
      `"${s.name.replace(/"/g, '""')}"`,
      s.date,
      formatHHMMSS(s.durationSeconds),
      formatHHMMSS(s.breakDurationSeconds),
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
            <header className="flex items-center justify-between h-12 border-b border-[#262626] pb-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 bg-[#FF4F00]"></div>
                <span className="font-bold text-lg tracking-tight text-[#F5F5F5] font-mono">Flow</span>
              </div>
              <div className="flex items-center gap-2">
                {user ? (
                  <button
                    onClick={handleLogout}
                    title="Sign Out"
                    className="flex items-center gap-1.5 text-xs text-[#8A8A8A] hover:text-[#F5F5F5] bg-[#141414] border border-[#262626] px-2.5 py-1 rounded-[4px] font-mono transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span className="truncate max-w-[80px]">{user.displayName || 'Account'}</span>
                  </button>
                ) : (
                  <button
                    onClick={handleLogin}
                    title="Sign In with Google"
                    className="flex items-center gap-1.5 text-xs text-white bg-[#FF4F00] hover:bg-[#E04600] px-3 py-1 rounded-[4px] font-mono font-medium transition-colors cursor-pointer"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    <span>Login</span>
                  </button>
                )}
                <button
                  onClick={() => setCurrentScreen('settings')}
                  className="text-[#8A8A8A] hover:text-[#F5F5F5] p-1 transition-colors"
                  aria-label="Settings"
                >
                  <Settings className="w-5 h-5" />
                </button>
              </div>
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
                  placeholder="e.g. Physics — Chapter 3"
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
             SCREEN 2 & 3: ACTIVE TIMER & AUTO-PAUSED SCREEN
             (Shared wrapper keeps live video stream continuous)
        ========================================================== */}
        {(currentScreen === 'active' || currentScreen === 'paused') && (
          <div className="flex-1 flex flex-col justify-between p-6 relative">
            <header className="flex items-center justify-between h-12 border-b border-[#262626] pb-3">
              <div className="text-xs text-[#8A8A8A] font-mono truncate max-w-[200px]">
                {sessionName || 'Untitled Session'}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-[#8A8A8A]">
                  Break: {formatHHMMSS(breakDurationSeconds)}
                </span>
                {currentScreen === 'active' ? (
                  <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#141414] border border-[#FF4F00] text-[11px] font-mono text-[#F5F5F5] rounded-[4px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#FF4F00] animate-pulse"></span>
                    Studying ✅
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#141414] border border-[#262626] text-[11px] font-mono text-[#8A8A8A] rounded-[4px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#8A8A8A]"></span>
                    Away ⏸️
                  </div>
                )}
              </div>
            </header>

            <div className="flex flex-col items-center justify-center my-auto">
              <div
                className={`font-mono text-6xl sm:text-7xl font-bold tracking-tighter tabular-nums mb-3 transition-opacity ${
                  currentScreen === 'paused' ? 'text-[#525252] opacity-50' : 'text-[#F5F5F5]'
                }`}
              >
                {formatHHMMSS(elapsedSeconds)}
              </div>

              {currentScreen === 'active' ? (
                <p className="text-xs text-[#8A8A8A] font-mono tracking-wider">
                  {!aiReady
                    ? 'Initializing AI Presence Sensor...'
                    : awayCountdown !== null
                    ? `No person detected · Pausing in ${awayCountdown}s`
                    : faceDetected
                    ? 'AI Presence Monitoring Active'
                    : 'Scanning for presence...'}
                </p>
              ) : (
                <p className="text-xs font-mono text-[#FF4F00] font-medium tracking-wider">
                  {pauseReason === 'auto'
                    ? returnCountdown !== null
                      ? `Stay in camera: Resuming in ${returnCountdown}s...`
                      : 'Step in front of camera for 5s to resume'
                    : 'Paused manually'}
                </p>
              )}
            </div>

            {currentScreen === 'active' ? (
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
            ) : (
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
            )}

            {/* Live Camera Feed Preview (Bottom-Right Corner) */}
            <div
              className={`absolute bottom-6 right-6 w-28 h-20 bg-[#141414] rounded-[4px] overflow-hidden flex flex-col justify-between z-20 transition-opacity ${
                currentScreen === 'paused'
                  ? 'border border-[#262626] opacity-80'
                  : faceDetected
                  ? 'border border-[#FF4F00]'
                  : 'border border-[#525252]'
              }`}
            >
              <button
                onClick={toggleFacingMode}
                title="Switch Camera (Front/Back)"
                className="absolute top-1 right-1 bg-[#0D0D0D]/90 hover:bg-[#FF4F00] text-[#F5F5F5] p-1 rounded-[2px] border border-[#262626] transition-colors z-10 cursor-pointer"
              >
                <SwitchCamera className="w-3 h-3" />
              </button>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full object-cover ${facingMode === 'user' ? 'scale-x-[-1]' : ''} ${cameraError ? 'hidden' : ''}`}
              />
              {cameraError && (
                <div className="w-full h-full flex flex-col items-center justify-center p-1 text-center bg-[#141414]">
                  <Video className="w-4 h-4 text-[#8A8A8A] mb-1" />
                  <span className="text-[8px] font-mono text-[#8A8A8A]">NO CAMERA</span>
                </div>
              )}
              <div className="absolute top-1 left-1 bg-[#0D0D0D]/85 px-1 py-0.5 rounded-[2px] text-[8px] font-mono flex items-center gap-1 border border-[#262626]">
                <span
                  className={`w-1 h-1 rounded-full ${
                    currentScreen === 'paused'
                      ? 'bg-[#8A8A8A]'
                      : faceDetected
                      ? 'bg-[#FF4F00]'
                      : 'bg-[#525252]'
                  }`}
                ></span>
                <span className={currentScreen === 'paused' ? 'text-[#8A8A8A]' : 'text-[#F5F5F5]'}>
                  {currentScreen === 'paused' ? (returnCountdown !== null ? `${returnCountdown}s` : 'AWAY') : faceDetected ? 'CAM' : 'SCAN'}
                </span>
              </div>
            </div>
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
                      <span className="block text-[10px] font-mono uppercase tracking-wider text-[#8A8A8A] mb-1">Total Duration</span>
                      <p className="font-mono text-base font-semibold text-[#F5F5F5]">
                        {formatHHMMSS(lastCompletedSession?.durationSeconds ?? elapsedSeconds)}
                      </p>
                    </div>
                    <div>
                      <span className="block text-[10px] font-mono uppercase tracking-wider text-[#8A8A8A] mb-1">Break Time</span>
                      <p className="font-mono text-base font-semibold text-[#FF4F00]">
                        {formatHHMMSS(lastCompletedSession?.breakDurationSeconds ?? breakDurationSeconds)}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
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
                  setBreakDurationSeconds(0);
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
              <div className="grid grid-cols-12 gap-2 px-3 py-2.5 border-b border-[#262626] bg-[#0D0D0D] text-[10px] font-mono uppercase tracking-wider text-[#8A8A8A]">
                <div className="col-span-4">Name</div>
                <div className="col-span-3">Date</div>
                <div className="col-span-3 text-right">Study / Break</div>
                <div className="col-span-2 text-right">P</div>
              </div>

              <div className="divide-y divide-[#262626] overflow-y-auto max-h-[300px]">
                {sessions.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[#525252]">
                    No study sessions recorded yet.
                  </div>
                ) : (
                  sessions.map((s) => (
                    <div key={s.id} className="grid grid-cols-12 gap-2 px-3 py-3 items-center text-xs hover:bg-[#1C1C1C] transition-colors">
                      <div className="col-span-4 font-medium text-[#F5F5F5] truncate" title={s.name}>
                        {s.name}
                      </div>
                      <div className="col-span-3 text-[#8A8A8A] font-mono text-[10px]">
                        {formatShortDate(s.date)}
                      </div>
                      <div className="col-span-3 text-right font-mono text-[#F5F5F5] text-[10px]">
                        <div>{formatHoursMinutes(s.durationSeconds)}</div>
                        <div className="text-[#FF4F00]">Brk: {Math.round(s.breakDurationSeconds / 60)}m</div>
                      </div>
                      <div className="col-span-2 text-right font-mono text-[#8A8A8A] text-[10px]">
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
                <h3 className="text-xs font-mono uppercase tracking-widest text-[#8A8A8A] mb-2">Firebase Account</h3>
                {user ? (
                  <div className="space-y-3">
                    <p className="text-xs text-[#F5F5F5] font-mono">Signed in as: <span className="text-[#FF4F00]">{user.email}</span></p>
                    <button
                      onClick={handleLogout}
                      className="bg-[#0D0D0D] hover:bg-[#1C1C1C] border border-[#262626] text-[#F5F5F5] px-4 py-2 text-xs font-mono rounded-[4px] transition-colors"
                    >
                      Sign Out
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-[#8A8A8A] mb-2">Sign in with Google to sync your study blocks across all your devices.</p>
                    <button
                      onClick={handleLogin}
                      className="bg-[#FF4F00] hover:bg-[#E04600] text-white px-4 py-2.5 text-xs font-mono font-medium rounded-[4px] flex items-center gap-2 transition-colors cursor-pointer"
                    >
                      <LogIn className="w-4 h-4" />
                      <span>Sign In with Google</span>
                    </button>
                  </div>
                )}
              </div>

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
