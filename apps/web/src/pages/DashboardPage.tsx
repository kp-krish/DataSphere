/**
 * A single dashboard: its widgets, in a 12-column grid, reorderable by drag.
 *
 * Reordering is optimistic. A drag is a direct manipulation - the card is
 * already under the pointer where the user dropped it - so waiting for a round
 * trip before moving it would feel broken. The server is the authority, so a
 * failed reorder rolls the order back and says why.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import type { Dashboard, Widget } from '@datasphere/core';
import { ApiError, deleteDashboard, getDashboard, reorderWidgets } from '../lib/api.js';
import { WidgetCard } from '../widgets/WidgetCard.js';

export function DashboardPage() {
  const { id = '' } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data, error, isPending } = useQuery<Dashboard>({
    queryKey: ['dashboard', id],
    queryFn: () => getDashboard(id),
    enabled: Boolean(id),
  });

  /**
   * Local copy of the order, so a drag can move a card immediately.
   * Re-synced whenever the server's version of the dashboard changes.
   */
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [reorderError, setReorderError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.widgets) setWidgets(data.widgets);
  }, [data]);

  const sensors = useSensors(
    // A small activation distance keeps a click on a header button from being
    // read as the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reorder = useMutation({
    mutationFn: (widgetIds: string[]) => reorderWidgets(id, widgetIds),
    onSuccess: (result) => {
      setReorderError(null);
      // Take the server's ordering, not the optimistic one: it is authoritative
      // and carries the recomputed position values.
      setWidgets(result.widgets);
      void queryClient.invalidateQueries({ queryKey: ['dashboard', id] });
    },
  });

  const removal = useMutation({
    mutationFn: () => deleteDashboard(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboards'] }),
  });

  const widgetIds = useMemo(() => widgets.map((widget) => widget.id), [widgets]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = widgetIds.indexOf(String(active.id));
    const to = widgetIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;

    const previous = widgets;
    const next = arrayMove(widgets, from, to);

    // Move the card immediately, then persist. The pre-drag order is captured
    // here in the closure so the failure path can put it back exactly.
    setWidgets(next);
    reorder.mutate(
      next.map((widget) => widget.id),
      {
        onError: (mutationError) => {
          setWidgets(previous);
          setReorderError(
            mutationError instanceof ApiError
              ? mutationError.message
              : 'Could not save the new order.',
          );
        },
      },
    );
  }

  if (isPending) return <p className="muted">Loading dashboard…</p>;

  if (error) {
    return (
      <div className="notice notice--error">
        <div>
          <div>{error instanceof ApiError ? error.message : 'Could not load this dashboard.'}</div>
          <Link to="/" className="muted">
            Back to dashboards
          </Link>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <>
      <header className="page__header">
        <div>
          <h1 className="page__title">{data.name}</h1>
          {data.description && <p className="page__subtitle">{data.description}</p>}
        </div>

        <div className="page__actions">
          <Link className="btn btn--primary" to={`/explore?dashboard=${id}`}>
            Add widget
          </Link>
          <button
            className="btn btn--danger"
            onClick={() => {
              if (confirm(`Delete "${data.name}" and all its widgets?`)) removal.mutate();
            }}
            disabled={removal.isPending}
          >
            Delete dashboard
          </button>
        </div>
      </header>

      {reorderError && (
        <div className="notice notice--error" style={{ marginBottom: '1rem' }}>
          {reorderError}
        </div>
      )}

      {widgets.length === 0 ? (
        <div className="empty">
          <p>This dashboard has no widgets yet.</p>
          <Link className="btn btn--primary" to={`/explore?dashboard=${id}`}>
            Build one
          </Link>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={widgetIds} strategy={rectSortingStrategy}>
            <div className="grid">
              {widgets.map((widget) => (
                <WidgetCard key={widget.id} widget={widget} dashboardId={id} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </>
  );
}
