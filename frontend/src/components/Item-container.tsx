import { forwardRef, useImperativeHandle, useRef } from 'react';
import Video from './video';
import Quiz from './quiz';
import Article from './article';
import ProjectItem from '../app/pages/teacher/components/ProjectItem';
import type { ArticleRef } from "@/types/article.types";
import type { QuizRef } from "@/types/quiz.types";
import type { ItemContainerProps, ItemContainerRef } from '@/types/item-container.types';
import FeedbackForm from '@/app/pages/student/components/FeedbackForm';
import { InlineStudentIleViewer } from '@/components/ile/InlineStudentIleViewer';

export interface ISubmitFeedbackBody {
  details: Record<string, any>;
  courseId: string;
  courseVersionId: string;
  // isSkipped?: boolean;
  cohortId?: string;
}
const ItemContainer = forwardRef<ItemContainerRef, ItemContainerProps>(({ item, nextItem, doGesture, onNext, onPrevVideo, isProgressUpdating, isNavigatingToPrev, readyToDetect, attemptId, anomalies, setQuizPassed, setAttemptId, rewindVid, pauseVid, pauseSignal, awayPaused, displayNextLesson, keyboardLockEnabled, setIsQuizSkipped, linearProgressionEnabled, seekForwardEnabled, courseId, versionId, completedItemIdsRef, cohortId, cohortName, previousItem, pendingStudentQuestionContext, clearPendingStudentQuestionContext, focusMode }, ref) => {
  const articleRef = useRef<ArticleRef>(null);
  const quizRef = useRef<QuizRef>(null);
  // Dead handle kept to avoid a refactor of stopCurrentItem below.
  // The ILE viewer no longer exposes a flush hook (the AI's events
  // are best-effort on unmount), so this ref is never written to.
  const ileFlushRef = useRef<(() => void) | null>(null);
  // courseId / versionId are kept on the props surface (the parent
  // course page passes them) but no per-item branch uses them after
  // the ILE viewer was simplified. cohortName is similarly unused
  // (the Video case used to pass it; the ILE case dropped it and
  // no other case needed it). Silence the unused warnings; if a
  // future item type needs them, just re-wire.
  void courseId; void versionId; void cohortName;

  // ✅ Expose stop function to parent - handles article and quiz
  useImperativeHandle(ref, () => ({
    stopCurrentItem: async () => {
      if (articleRef.current) {
        await articleRef.current.stopItem();
      } else if (quizRef.current) {
        await quizRef.current.stopItem();
      } else if (ileFlushRef.current) {
        // Force-flush the ILE runtime's analytics buffer. The
        // iframe itself is unmounted by React (the parent stops
        // rendering this case when the next item becomes
        // current) — flushing here captures events that would
        // otherwise sit in the runtime queue for up to 2s.
        ileFlushRef.current();
      }
    },
    getCurrentDetails: () => {
      if (quizRef.current?.getCurrentDetails) {
        return quizRef.current.getCurrentDetails();
      }
      return {};
    }
  }));
  // const submitFeedback = useSubmitFeedback(item._id.toString()) — disabled
  // while the feedback persistence path is being verified end-to-end. The
  // hook remains imported so callers can re-enable it without a new
  // import statement; this comment lives here so the placeholder
  // doesn't get blindly deleted.
  // const submitFeedback = useSubmitFeedback(item._id.toString());

  const handleFeedbackSubmit = async (_formData: any) => {
    // Submitted feedback persistence is intentionally a no-op while
    // the new FeedbackForm integration is being verified end-to-end.
    // When the persistence path is wired, this handler should:
    //   1. Validate the formData against the jsonSchema
    //   2. POST to the feedback endpoint via `submitFeedback`
    //   3. Trigger the parent's `onNext()` to advance the lesson
    // For now we keep the shape so FeedbackForm's onSubmit type
    // continues to match.
  };

  const renderContent = () => {
    const itemType = item.type.toLowerCase();
    switch (itemType) {
      case 'video':
        /**
         * One player component for both sources. Video picks an HLS or YouTube
         * backend from `source` internally, so proctoring, seek gating,
         * watch-time and the overlays are shared rather than duplicated —
         * uploaded lessons get the same enforcement as YouTube ones.
         */
        return <Video
          key={item._id.toString()}
          URL={item.details?.URL ? item.details.URL : ''}
          source={item.details?.source}
          assetId={item.details?.assetId}
          startTime={item.details?.startTime ? item.details.startTime : ''}
          endTime={item.details?.endTime ? item.details.endTime : ''}
          points={item.details?.points ? item.details.points : ''}
          doGesture={doGesture}
          onNext={onNext}
          keyboardLockEnabled={keyboardLockEnabled}
          focusMode={focusMode}
          isProgressUpdating={isProgressUpdating}
          rewindVid={rewindVid || false}
          pauseVid={pauseVid || false}
          pauseSignal={pauseSignal}
          awayPaused={awayPaused}
          readyToDetect={readyToDetect}
          anomalies={anomalies}
          linearProgressionEnabled={linearProgressionEnabled}
          seekForwardEnabled={seekForwardEnabled}
          isCompleted={item.isCompleted || false}
          isAlreadyWatched = {item.isAlreadyWatched || false}
          completedItemIdsRef={completedItemIdsRef}
          nextItemId={nextItem?.itemId?.toString()}
          cohortId={cohortId}
        />;

      case 'quiz':
        return <Quiz
          key={item._id.toString()}
          ref={quizRef}
          questionBankRefs={item.details?.questionBankRefs || []}
          passThreshold={item.details?.passThreshold || 0}
          maxAttempts={item.details?.maxAttempts || 1}
          quizType={item.details?.quizType || ''}
          releaseTime={item.details?.releaseTime}
          questionVisibility={item.details?.questionVisibility || 0}
          deadline={item.details?.deadline}
          approximateTimeToComplete={item.details?.approximateTimeToComplete || ''}
          allowPartialGrading={item.details?.allowPartialGrading || false}
          allowHint={item.details?.allowHint || false}
          allowSkip={item.details?.allowSkip || false}
          showCorrectAnswersAfterSubmission={item.details?.showCorrectAnswersAfterSubmission || false}
          showExplanationAfterSubmission={item.details?.showExplanationAfterSubmission || false}
          showScoreAfterSubmission={item.details?.showScoreAfterSubmission || false}
          quizId={item._id || ''}
          doGesture={doGesture}
          onNext={onNext}
          onPrevVideo={onPrevVideo}
          isProgressUpdating={isProgressUpdating}
          isNavigatingToPrev={isNavigatingToPrev}
          attemptId={attemptId}
          setAttemptId={setAttemptId}
          displayNextLesson={displayNextLesson}
          setQuizPassed={setQuizPassed}
          rewindVid={rewindVid}
          setIsQuizSkipped={setIsQuizSkipped}
          linearProgressionEnabled={linearProgressionEnabled}
          isAlreadyWatched={item.isAlreadyWatched || false}
          completedItemIdsRef={completedItemIdsRef}
          nextItemId={nextItem?.itemId?.toString()}
          pendingStudentQuestionContext={pendingStudentQuestionContext}
          clearPendingStudentQuestionContext={clearPendingStudentQuestionContext}
        />;

      case 'article':
      case 'blog':
        return <Article
          key={item._id.toString()}
          ref={articleRef}
          content={item.details?.content || ''}
          estimatedReadTimeInMinutes={item.details?.estimatedReadTimeInMinutes || ''}
          tags={item.details?.tags || []}
          points={item.details?.points || ''}
          onNext={onNext}
          isProgressUpdating={isProgressUpdating}
          isAlreadyWatched={item.isAlreadyWatched || false}
          completedItemIdsRef={completedItemIdsRef}
        />;

      case 'project':
        return <ProjectItem
          key={item._id.toString()}
          item={{
            _id: item._id,
            name: item.name,
            type: 'PROJECT',
            description: item.details?.description || item.description || ''
          }}
          onSave={() => { }} // Not used in student view
          onCancel={() => { }} // Not used in student view
          isInstructor={false}
          onNext={onNext}
          isProgressUpdating={isProgressUpdating}
        />;
      case 'feedback':
        return <FeedbackForm
          key={item._id.toString()}
          title={item.name}
          description={item.description}
          isOptional={item.isOptional}
          jsonSchema={item?.details?.jsonSchema}
          uiSchema={item?.details?.uiSchema}
          onSubmit={handleFeedbackSubmit}
          isSubmitting={isProgressUpdating}
          onNext={onNext}
          isAlreadyWatched={item.isAlreadyWatched || false}
          completedItemIdsRef={completedItemIdsRef}
          previousItem = {previousItem}
        />;

      case 'interactive_experience': {
        // The itemsGroup row's `details.experienceId` is the ILE
        // doc's _id. The unified save-with-item + link-item endpoints
        // both write it in the same Mongo transaction as the ILE
        // doc, so we can trust it to be present once the row
        // exists. If for any reason it's missing (e.g. legacy
        // pre-link data) the inline view shows its empty state
        // and the student gets a clear "this experience is
        // missing its content" message.
        //
        // The inline viewer is bare-bones: no chrome, no
        // onCompleteAdvance, no flush hook. The course page's
        // own onNext handles completion advancement via the
        // `stopCurrentItem → markItemComplete` flow, and the
        // AI's HTML is best-effort on unmount (no postMessage
        // plumbing here).
        const experienceId = item.details?.experienceId;
        return (
          <InlineStudentIleViewer
            key={item._id.toString()}
            experienceId={experienceId ?? ''}
          />
        );
      }

      default:
        return (
          <div className="flex items-center justify-center h-64">
            <p className="text-muted-foreground">Unsupported item type: {item.type}</p>
          </div>
        );
    }
  };

  return (
    <div className={`${item.type.toLowerCase()==="video" ? (focusMode ? "fixed inset-0 z-40 bg-stage h-screen" : "h-[85vh]") : "h-full" } w-full overflow-auto`}>
      {renderContent()}
    </div>
  );
});

ItemContainer.displayName = 'ItemContainer';

export default ItemContainer;