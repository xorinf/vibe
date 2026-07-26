import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { askCoach } from './ileApi';

export function AICoachPanel({ open, onClose, experienceId }: { open: boolean; onClose: () => void; experienceId: string | undefined }) {
  const [prompt, setPrompt] = useState('');
  const [hint, setHint] = useState('Ask the coach for a hint about this experience.');
  const [loading, setLoading] = useState(false);
  async function submit() {
    if (!experienceId || !prompt.trim()) return;
    setLoading(true);
    try { setHint((await askCoach(experienceId, prompt.trim())).hint); }
    catch (error) { setHint(error instanceof Error ? error.message : 'Could not reach the coach.'); }
    finally { setLoading(false); }
  }
  return <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
    <DialogContent role="dialog" aria-modal="true" className="border-slate-700 bg-slate-900 text-slate-100">
      <DialogHeader><DialogTitle>AI Coach</DialogTitle><DialogDescription className="text-slate-300">{hint}</DialogDescription></DialogHeader>
      <div className="flex gap-2"><input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="Ask a question" aria-label="Ask a question" className="min-h-10 flex-1 rounded-md border border-slate-600 bg-slate-800 px-3 text-sm" /><Button onClick={submit} disabled={loading} className="min-h-10">{loading ? 'Asking…' : 'Ask'}</Button></div>
      <Button variant="ghost" onClick={onClose} aria-label="Close coach" className="absolute right-2 top-2 min-h-10 min-w-10 p-0"><X className="h-4 w-4" /></Button>
    </DialogContent>
  </Dialog>;
}
