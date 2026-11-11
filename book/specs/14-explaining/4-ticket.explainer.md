---
title: Selling the last seat
lede: How a theatre's box office sells its last seat to exactly one person, charges them exactly once, and survives a restart in the middle of it all.
depth: 40
---

## Three parties, one seat

A theatre has one seat left, A1. People buy it from their phones. The theatre's website, the
*box office*, keeps the seat in its database and asks the *bank*, the card processor, to
charge whoever pays for it.

::map{scenario="Alice buys the last seat"}

Selling a seat sounds like one step, and it's two. First the box office *holds* the seat for
ten minutes, so nobody else can take it while you type your card number. Then you *pay*, and
the box office asks the bank to charge you. Everything interesting in this system happens
between those two steps, or between the box office and the bank.

Two things live in the box office's memory rather than its database, and both matter later:
the ten-minute timer on a hold, and the fact that it is waiting on the bank. A restart forgets
both.

## When everything goes right

Alice holds the seat, pays while the hold lasts, the bank charges her card, and she gets the
ticket. Bob is there too, but he never asks.

::figure{name="HoldThenPay"}

The seat's row on the box office goes *free*, then *held* with an order number, then
*paying*, then *sold*. The order number is opened with the hold, and it follows the payment
all the way to the bank. Most of what follows is about that number.

## Paying for someone else's hold

Holds expire. That's their job: a person who walks away shouldn't keep the seat forever. But
an expired hold can be taken by someone else, and a payment can still be on its way.

::steps{breaks="payOnlyTheHolder" at="3,5,6,7,broke"}

Alice and Bob both ask for the seat. Alice gets it and pays, but her payment is slow, and the
ten minutes run out before it arrives. The seat is free again, so Bob's request holds it for
*him*. Then Alice's payment lands, and the box office, seeing a held seat, charges her for it.
Alice pays for a hold that is Bob's:

::still{breaks="payOnlyTheHolder" at=broke}

No fault was needed. Nothing was lost or crashed: the messages just arrived in an order nobody
thought about. The fix is the rule **a payment counts only for the hold it pays for**: the box
office checks that whoever pays is whoever holds, and tells Alice her hold expired.

## The bank's answer is lost

The box office calls the bank over HTTPS. If the call fails, it tries again, which is what any
client should do. But a call can fail *after* the bank did the work: the answer can be lost on
its way back. The box office can't tell the difference.

::steps{scenario="The bank's answer is lost" at="5,6,7,8,9"}

Here the retry is harmless, because the bank remembers the orders it has charged and charges
each one once. That is the rule **the bank charges each order once**, and the order number from
the hold is what makes it possible. Without it:

::figure{name="DoubleCharge"}

One fault is enough: the network delivers the charge twice, and the bank, which no longer
looks at order numbers, charges the buyer twice. A lost answer followed by a retry does the same.
A duplicate is just the shortest way there.

## A restart mid-payment

The box office is a process, and processes restart: a deploy, a crash, a machine going away.
Its database survives. Its memory doesn't.

When it comes back, the box office looks in its database for payments in progress, and charges
them again. That's safe, for the reason in the last section: the bank charges each order once.
That is the rule **after a restart, resume the payments the database says are in progress**.
Without it, a buyer can wait forever:

::steps{breaks="resumePayments" at="5,6,7"}

The charge is lost on its way to the bank, so the call fails. Before the box office hears
about the failure, it restarts, and the failure is gone with its memory. Now the database says
*paying*, the bank never heard of the order, and nobody will ever call it again. The buyer's
phone says *paying*, and it always will.

It takes two faults, a lost message and a restart at just the wrong moment. That's rare, and
it's exactly the kind of thing that happens once a week at scale.

## A hold that never ends

The ten-minute timer lives in memory too.

::figure{name="ForgottenTimer"}

The box office holds the seat for Alice and restarts before she pays. The hold is in the
database, but the timer that would end it is gone. If Alice walks away, the seat stays held
forever, and nobody else can buy it. The rule **after a restart, set the expiry of every hold
again** closes it: on startup, the box office sets a timer for every hold it finds.

## What we know, and how sure we are

::verdicts

Every property holds. That is a claim about the model, within its bounds: one buyer from the
start, and Alice and Bob from the scenarios' setups, at most two faults on any path, and every
order of events up to 40 steps. Within those bounds it isn't a sample: every order was tried.

::rules

And every rule earns its place. None of them is there just in case.

## What this doesn't say

The model is the design, not the code. It says the design is right; whether the code does what
the design says is a separate question, answered by linking each step to the code it stands for
(chapter 13 of the book). It also leaves out what it doesn't need: card details, prices, more
seats, more than two people. Each was left out because it doesn't change the answer to the
questions above, and adding one means checking again.
