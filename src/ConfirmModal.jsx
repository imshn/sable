import React from 'react'
import { Icon } from './icons.jsx'

export function ConfirmModal({ title, message, onConfirm, onCancel, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn subtle" onClick={onCancel} title="Close">{Icon.x}</button>
        </header>

        <div className="modal-content" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p>{message}</p>
          
          <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '16px' }}>
            <button type="button" className="secondary" onClick={onCancel}>{cancelText}</button>
            <button type="button" className={`primary ${danger ? 'danger' : ''}`} onClick={onConfirm} style={danger ? { backgroundColor: 'var(--red)', color: 'white', borderColor: 'transparent' } : {}}>
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
