import Bot from '../Bot';

import { XMLHttpRequest } from 'xmlhttprequest-ts';
import { TradeOffer } from 'steam-tradeoffer-manager';
import log from '../../lib/logger';
import Currencies from 'tf2-currencies';
import MyHandler from '../MyHandler';
import pluralize from 'pluralize';

import { pure } from '../../lib/tools/pure';
import stats from '../../lib/tools/stats';
import summarize from '../../lib/tools/summarizeOffer';
import listItems from '../../lib/tools/summarizeItems';
import { replaceItemName, replaceSpecialChar } from '../../lib/tools/replace';

import { getPartnerDetails, quickLinks } from './utils';
import { enableMentionOwner, tradeSummaryLinks, skusToMention } from './userSettings';

export default function sendTradeSummary(
    offer: TradeOffer,
    autokeys: { isEnabled: boolean; isActive: boolean; isBuying: boolean; isBanking: boolean },
    currentItems: number,
    backpackSlots: number,
    accepted: {
        invalidItems: string[];
        overstocked: string[];
        understocked: string[];
        highValue: string[];
        isMention: boolean;
    },
    keyPrices: { buy: Currencies; sell: Currencies; src: string },
    value: { diff: number; diffRef: number; diffKey: string },
    items: { their: string[]; our: string[] },
    links: { steam: string; bptf: string; steamrep: string },
    time: string,
    bot: Bot
): void {
    const ourItems = items.our;
    const theirItems = items.their;

    const itemsName = {
        invalid: accepted.invalidItems.map(name => replaceItemName(name)), // 🟨_INVALID_ITEMS
        overstock: accepted.overstocked.map(name => replaceItemName(name)), // 🟦_OVERSTOCKED
        understock: accepted.understocked.map(name => replaceItemName(name)), // 🟩_UNDERSTOCKED
        duped: [],
        dupedFailed: [],
        highValue: accepted.highValue.map(name => replaceItemName(name)) // 🔶_HIGH_VALUE_ITEMS
    };

    const itemList = listItems(itemsName, false);

    // Mention owner on the sku(s) specified in DISCORD_WEBHOOK_TRADE_SUMMARY_MENTION_OWNER_ONLY_ITEMS_SKU
    const isMentionOurItems = skusToMention.some(fromEnv => {
        return ourItems.some(ourItemSKU => {
            return ourItemSKU.includes(fromEnv);
        });
    });

    const isMentionThierItems = skusToMention.some(fromEnv => {
        return theirItems.some(theirItemSKU => {
            return theirItemSKU.includes(fromEnv);
        });
    });

    const IVAmount = itemsName.invalid.length;
    const HVAmount = itemsName.highValue.length;
    const isMentionHV = accepted.isMention;

    const mentionOwner =
        IVAmount > 0 || isMentionHV // Only mention on accepted 🟨_INVALID_ITEMS or 🔶_HIGH_VALUE_ITEMS
            ? `<@!${process.env.DISCORD_OWNER_ID}> - Accepted ${
                  IVAmount > 0 && isMentionHV
                      ? `INVALID_ITEMS and High value ${pluralize('item', IVAmount + HVAmount)}`
                      : IVAmount > 0 && !isMentionHV
                      ? `INVALID_ITEMS ${pluralize('item', IVAmount)}`
                      : IVAmount === 0 && isMentionHV
                      ? `High Value ${pluralize('item', HVAmount)}`
                      : ''
              } trade here!`
            : enableMentionOwner === true && (isMentionOurItems || isMentionThierItems)
            ? `<@!${process.env.DISCORD_OWNER_ID}>`
            : '';

    const tradeLinks = tradeSummaryLinks;
    const botInfo = (bot.handler as MyHandler).getBotInfo();
    const pureStock = pure(bot);
    const trades = stats(bot);

    const tradeNumbertoShowStarter = parseInt(process.env.TRADES_MADE_STARTER_VALUE);

    const tradesMade =
        tradeNumbertoShowStarter !== 0 && !isNaN(tradeNumbertoShowStarter)
            ? tradeNumbertoShowStarter + trades.tradesTotal
            : trades.tradesTotal;

    const summary = summarize(offer.summarizeWithLink(bot.schema), value, keyPrices, false);

    let personaName: string;
    let avatarFull: string;
    log.debug('getting partner Avatar and Name...');
    getPartnerDetails(offer, bot, (err, details) => {
        if (err) {
            log.debug('Error retrieving partner Avatar and Name: ', err);
            personaName = 'unknown';
            avatarFull =
                'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/72/72f78b4c8cc1f62323f8a33f6d53e27db57c2252_full.jpg'; //default "?" image
        } else {
            log.debug('partner Avatar and Name retrieved. Applying...');
            personaName = details.personaName;
            avatarFull = details.avatarFull;
        }

        const partnerNameNoFormat = replaceSpecialChar(personaName);

        const isShowQuickLinks = process.env.DISCORD_WEBHOOK_TRADE_SUMMARY_SHOW_QUICK_LINKS !== 'false';
        const isShowKeyRate = process.env.DISCORD_WEBHOOK_TRADE_SUMMARY_SHOW_KEY_RATE !== 'false';
        const isShowPureStock = process.env.DISCORD_WEBHOOK_TRADE_SUMMARY_SHOW_PURE_STOCK !== 'false';
        const isShowInventory = process.env.DISCORD_WEBHOOK_TRADE_SUMMARY_SHOW_INVENTORY !== 'false';
        const AdditionalNotes = process.env.DISCORD_WEBHOOK_TRADE_SUMMARY_ADDITIONAL_DESCRIPTION_NOTE;

        /*eslint-disable */
        const acceptedTradeSummary = {
            username: process.env.DISCORD_WEBHOOK_USERNAME ? process.env.DISCORD_WEBHOOK_USERNAME : botInfo.name,
            avatar_url: process.env.DISCORD_WEBHOOK_AVATAR_URL
                ? process.env.DISCORD_WEBHOOK_AVATAR_URL
                : botInfo.avatarURL,
            content: mentionOwner,
            embeds: [
                {
                    author: {
                        name: `Trade from: ${personaName} #${tradesMade.toString()}`,
                        url: links.steam,
                        icon_url: avatarFull
                    },
                    footer: {
                        text: `Offer #${offer.id} • SteamID: ${offer.partner.toString()} • ${time}`
                    },
                    thumbnail: {
                        url: ''
                    },
                    title: '',
                    description:
                        summary + (isShowQuickLinks ? `\n\n${quickLinks(partnerNameNoFormat, links)}\n` : '\n'),
                    fields: [
                        {
                            name: '__Item list__',
                            value: itemList.replace(/@/g, '')
                        },
                        {
                            name: '__Status__',
                            value:
                                (isShowKeyRate
                                    ? `\n🔑 Key rate: ${keyPrices.buy.metal.toString()}/${keyPrices.sell.metal.toString()} ref` +
                                      ` (${keyPrices.src === 'manual' ? 'manual' : 'prices.tf'})` +
                                      `${
                                          autokeys.isEnabled
                                              ? ' | Autokeys: ' +
                                                (autokeys.isActive
                                                    ? '✅' +
                                                      (autokeys.isBanking
                                                          ? ' (banking)'
                                                          : autokeys.isBuying
                                                          ? ' (buying)'
                                                          : ' (selling)')
                                                    : '🛑')
                                              : ''
                                      }`
                                    : '') +
                                (isShowPureStock ? `\n💰 Pure stock: ${pureStock.join(', ').toString()}` : '') +
                                (isShowInventory
                                    ? `\n🎒 Total items: ${currentItems +
                                          (backpackSlots !== 0 ? '/' + backpackSlots : '')}`
                                    : '') +
                                (AdditionalNotes
                                    ? (isShowKeyRate || isShowPureStock || isShowInventory ? '\n' : '') +
                                      AdditionalNotes
                                    : `\n[View my backpack](https://backpack.tf/profiles/${botInfo.steamID})`)
                        }
                    ],
                    color: process.env.DISCORD_WEBHOOK_EMBED_COLOR_IN_DECIMAL_INDEX
                }
            ]
        };
        /*eslint-enable */

        let removeStatus = false;

        if (!(isShowKeyRate || isShowPureStock || isShowInventory || AdditionalNotes)) {
            // If everything here is false, then it will be true and the last element (__Status__) of the
            // fields array will be removed
            acceptedTradeSummary.embeds[0].fields.pop();
            removeStatus = true;
        }

        if (itemList === '-') {
            // if __Item list__ field is empty OR contains more than 1024 characters, then remove it
            // to prevent the webhook from failing on POST request
            if (removeStatus) {
                // if __Status__ fields was removed, then delete the entire fields properties
                delete acceptedTradeSummary.embeds[0].fields;
            } else {
                // else just remove the __Item list__
                acceptedTradeSummary.embeds[0].fields.shift();
            }
        } else if (itemList.length >= 1024) {
            // first get __Status__ element
            const statusElement = acceptedTradeSummary.embeds[0].fields.pop();

            // now remove __Item list__, so now it should be empty
            acceptedTradeSummary.embeds[0].fields.length = 0;

            const separate = itemList.split('@');

            let newSentences = '';
            let j = 1;
            separate.forEach((sentence, i) => {
                if ((newSentences.length >= 800 || i === separate.length - 1) && !(j > 4)) {
                    acceptedTradeSummary.embeds[0].fields.push({
                        name: `__Item list ${j}__`,
                        value: newSentences.replace(/@/g, '')
                    });

                    if (i === separate.length - 1 || j > 4) {
                        acceptedTradeSummary.embeds[0].fields.push(statusElement);
                    }

                    newSentences = '';
                    j++;
                } else {
                    newSentences += sentence;
                }
            });
        }

        tradeLinks.forEach((link, i) => {
            const request = new XMLHttpRequest();
            request.open('POST', link);
            request.setRequestHeader('Content-type', 'application/json');
            // remove mention owner on the second or more links, so the owner will not getting mentioned on the other servers.
            request.send(
                i > 0
                    ? JSON.stringify(acceptedTradeSummary).replace(/<@!\d+>/g, '')
                    : JSON.stringify(acceptedTradeSummary)
            );
        });
    });
}
