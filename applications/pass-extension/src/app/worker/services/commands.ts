import { withContext } from 'proton-pass-extension/app/worker/context/inject';
import { backgroundMessage, sendTabMessage } from 'proton-pass-extension/lib/message/send-message';
import { WorkerMessageType } from 'proton-pass-extension/types/messages';

import { clientReady } from '@proton/pass/lib/client';
import { intoUserIdentifier } from '@proton/pass/lib/items/item.utils';
import browser from '@proton/pass/lib/globals/browser';
import { LockMode } from '@proton/pass/lib/auth/lock/types';
import { itemAutofilled } from '@proton/pass/store/actions/creators/item';
import { deobfuscate } from '@proton/pass/utils/obfuscate/xor';
import { logger } from '@proton/pass/utils/logger';
import noop from '@proton/utils/noop';

/** Extension command names matching the `commands` keys in the manifest */
const COMMAND_AUTOFILL_LOGIN = 'autofill_login';
const COMMAND_LOCK_VAULT = 'lock_vault';

export const createCommandsService = () => {
    const handleAutofillCommand = withContext(async (ctx) => {
        if (!clientReady(ctx.status)) {
            logger.info('[CommandsService] Ignoring autofill command: worker not ready');
            return;
        }

        if (!ctx.getState().authorized) {
            logger.info('[CommandsService] Ignoring autofill command: not authorized');
            return;
        }

        try {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id || !tab.url) return;

            const candidates = ctx.service.autofill.getLoginCandidates({ url: tab.url });

            if (candidates.length === 0) {
                logger.info('[CommandsService] No login candidates for active tab');
                return;
            }

            if (candidates.length === 1) {
                const item = candidates[0];
                if (item.data.type !== 'login') return;

                ctx.service.store.dispatch(itemAutofilled({ shareId: item.shareId, itemId: item.itemId }));

                const credentials = {
                    userIdentifier: intoUserIdentifier(item),
                    password: deobfuscate(item.data.content.password),
                };

                await sendTabMessage(
                    backgroundMessage({
                        type: WorkerMessageType.AUTOFILL_LOGIN_COMMAND,
                        payload: credentials,
                    }),
                    { tabId: tab.id }
                );

                logger.info('[CommandsService] Autofill credentials sent to active tab');
                return;
            }

            /* Multiple candidates: open the extension popup so the user can pick one */
            if (candidates.length > 1) {
                logger.info(`[CommandsService] ${candidates.length} candidates found, opening popup`);
                await browser.action.openPopup().catch(noop);
            }
        } catch (error) {
            logger.warn('[CommandsService] Autofill command failed', error);
        }
    });

    const handleLockCommand = withContext(async (ctx) => {
        if (!clientReady(ctx.status)) {
            logger.info('[CommandsService] Ignoring lock command: worker not ready');
            return;
        }

        if (!ctx.getState().authorized) {
            logger.info('[CommandsService] Ignoring lock command: not authorized (already locked?)');
            return;
        }

        try {
            const lockMode = ctx.authStore.getLockMode();
            if (lockMode === LockMode.NONE) {
                logger.info('[CommandsService] No lock mode configured, cannot lock');
                return;
            }

            await ctx.service.auth.lock(lockMode, { soft: false, userInitiated: true });
            logger.info('[CommandsService] Vault locked via keyboard shortcut');
        } catch (error) {
            logger.warn('[CommandsService] Lock command failed', error);
        }
    });

    const init = () => {
        if (browser.commands?.onCommand) {
            browser.commands.onCommand.addListener(async (command: string) => {
                logger.info(`[CommandsService] Received command: ${command}`);
                switch (command) {
                    case COMMAND_AUTOFILL_LOGIN:
                        return handleAutofillCommand();
                    case COMMAND_LOCK_VAULT:
                        return handleLockCommand();
                    default:
                        logger.info(`[CommandsService] Unknown command: ${command}`);
                }
            });

            logger.info('[CommandsService] Commands listener registered');
        }
    };

    return { init };
};

export type CommandsService = ReturnType<typeof createCommandsService>;
