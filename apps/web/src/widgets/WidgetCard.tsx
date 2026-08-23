/**
 * One widget on a dashboard: header, data fetch, and the rendered view.
 *
 * Each card owns its own query. Fetching the whole dashboard's data in one
 * request would mean one slow widget blocks every other, and a single
 * invalidation would refetch everything rather than only what changed.
 *
 * On refetch the previous render is held at reduced opacity rather than
 * swapped for a skeleton. A skeleton flashes and jumps the layout for data
 * that is usually about to look almost identical.
 */

import { useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Widget } from '@datasphere/core';
import { deleteWidget, getWidgetData } from '../lib/api.js';
import { ApiError } from '../lib/api.js';
import { CacheBadge } from '../components/CacheBadge.js';
import { WidgetView } from './WidgetView.js';

export interface WidgetCardProps {
  widget: Widget;
  dashboardId: string;
  /** Drag-to-reorder is disabled while the dashboard is in read-only use. */
  sortable?: boolean;
}

/** Plot height per unit of the widget's configured height. */
const HEIGHT_UNIT = 200;

export function WidgetCard({ widget, dashboardId, sortable = true }: WidgetCardProps) {
  const queryClient = useQueryClient();
  const [showTable, setShowTable] = useState(widget.type === 'table');

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: widget.id,
    disabled: !sortable,
  });

  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['widget-data', widget.id],
    queryFn: () => getWidgetData(widget.id),
    // The widget's own configured interval, when it has one. Live updates
    // arrive over SSE, so polling is a fallback rather than the mechanism.
    refetchInterval: widget.config.refreshInterval ? widget.config.refreshInterval * 1000 : false,
  });

  const removal = useMutation({
    mutationFn: () => deleteWidget(widget.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard', dashboardId] }),
  });

  const plotHeight = Math.max(160, (widget.height || 1) * HEIGHT_UNIT - 60);

  return (
    <article
      ref={setNodeRef}
      className={`widget${isDragging ? ' widget--dragging' : ''}`}
      style={
        {
          // Drives `grid-column: span var(--span)`, so a widget's stored width
          // maps straight onto the 12-column grid.
          '--span': widget.width,
          transform: CSS.Transform.toString(transform),
          transition,
        } as CSSProperties
      }
      aria-label={widget.title}
    >
      <header className="widget__head">
        {sortable && (
          <button
            className="widget__drag"
            aria-label={`Reorder ${widget.title}`}
            {...attributes}
            {...listeners}
          >
            {/* Grip: purely decorative, the button carries the label. */}
            <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
              <g fill="currentColor">
                <circle cx="3" cy="3" r="1.4" />
                <circle cx="9" cy="3" r="1.4" />
                <circle cx="3" cy="8" r="1.4" />
                <circle cx="9" cy="8" r="1.4" />
                <circle cx="3" cy="13" r="1.4" />
                <circle cx="9" cy="13" r="1.4" />
              </g>
            </svg>
          </button>
        )}

        <h3 className="widget__title" title={widget.title}>
          {widget.title}
        </h3>

        {/* A sibling of the tools rather than one of them, so a narrow card can
            drop it to its own row instead of eating the title. See the
            container query in styles.css. */}
        {data && <CacheBadge meta={data.meta} />}

        <div className="widget__tools">
          {/* Icon buttons, not labelled ones. Three words of chrome in the
              header squeezed the title out of a 3-column card entirely - it
              rendered as "T." - so the labels moved into tooltips and
              aria-labels, where they are still reachable. */}
          {widget.type !== 'table' && (
            <button
              className="widget__tool"
              onClick={() => setShowTable((value) => !value)}
              aria-pressed={showTable}
              aria-label={showTable ? 'Show chart' : 'Show table view'}
              title={
                showTable
                  ? 'Show the chart'
                  : 'Show the table view — every value, without relying on colour'
              }
            >
              {showTable ? <IconChart /> : <IconTable />}
            </button>
          )}

          <button
            className="widget__tool"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-label="Refresh data"
            title="Refetch this widget"
          >
            <IconRefresh />
          </button>

          <button
            className="widget__tool widget__tool--danger"
            onClick={() => {
              if (confirm(`Delete widget "${widget.title}"?`)) removal.mutate();
            }}
            disabled={removal.isPending}
            aria-label={`Delete ${widget.title}`}
            title="Delete widget"
          >
            <IconTrash />
          </button>
        </div>
      </header>

      <div className={`widget__body${isFetching && !isPending ? ' widget__body--refetching' : ''}`}>
        {isPending && <p className="muted">Loading…</p>}

        {error && (
          <div className="notice notice--error">
            <div>
              <div>{error instanceof ApiError ? error.message : 'Failed to load data.'}</div>
              {error instanceof ApiError && <div className="notice__code">{error.code}</div>}
            </div>
          </div>
        )}

        {data && (
          <WidgetView
            type={widget.type}
            result={data}
            config={widget.config}
            height={plotHeight}
            asTable={showTable}
          />
        )}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/*                                                                            */
/* Inline and decorative: each sits inside a button that carries the label, so */
/* they are hidden from assistive technology rather than announced twice.      */
/* -------------------------------------------------------------------------- */

const ICON = {
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function IconTable() {
  return (
    <svg {...ICON}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5V13" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg {...ICON}>
      <path d="M2 13V3M2 13h12" />
      <path d="M5 10.5l3-3.5 2.5 2L14 5" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg {...ICON}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2v3.2h-3.2" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg {...ICON}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" />
    </svg>
  );
}
